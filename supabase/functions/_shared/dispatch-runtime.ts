/**
 * ディスパッチャの実行時配線（契約 スライスCD）。
 *
 * 判断は `_shared/dispatch.ts` の純ロジックに閉じてある。ここは
 * **Supabase と fetch を繋ぐだけ**である。`dispatch-daily` と `dispatch-weekly` で
 * 同じ配線を2回書くと、片方だけ直したときに宛先の取り方が割れる。
 */

import { getSupabaseAdmin } from "./supabase-client.ts";
import { mustCount, mustData, takeError } from "./db.ts";
import { resolveMailConfig, sendEmail } from "./mailer.ts";
import { STRIPE_RETRY_WINDOW_DAYS } from "./dispatch.ts";
import {
  COMPANY_TIMEOUT_MS,
  planResume,
  type ResumeRow,
} from "./dispatch-resume.ts";
import {
  ABANDONED,
  STALE_SENDING,
  planStaleSweep,
  type StaleRow,
} from "./stale-sending.ts";
import type {
  BillingCounts,
  CompanyTarget,
  ConnectionState,
  DispatchDeps,
  DispatchRecord,
  InvokeResult,
  OpsNotifyResult,
  DispatchKind,
} from "./dispatch.ts";

/**
 * 宛先の正本は `auth.users.email`（CD-D1）。**新しいテーブルを作らない。**
 *
 * RLS ポリシー（`00019`）が `company_id = auth.uid()` なので、
 * 会社とアカウントは 1:1 である（`src/lib/auth/company.ts` と同じ前提）。
 * したがって `auth.users.id` がそのまま `company_id` になる。
 */
/** 1回の `listUsers` で取る件数。Supabase の上限（1000）より小さくしておく */
const TARGET_PAGE_SIZE = 200;

/**
 * 取りに行くページ数の上限。**無限ループにしないための止め具**であり、
 * ここに当たったら「取り切れていない」である（会社数の想定ではない）。
 */
const MAX_TARGET_PAGES = 25;

/** `user_metadata` から購読の状態だけを取り出す（B-4）。**引けなければ null** */
function subscriptionStatusOf(metadata: unknown): string | null {
  const sub = (metadata as { subscription?: { status?: unknown } } | null)?.subscription;
  return typeof sub?.status === "string" && sub.status ? sub.status : null;
}

/**
 * 掃除で一度に引く行数の上限。
 *
 * **無制限に引かない。** 固まった行が大量にあるとき、全部を1回で倒そうとして
 * Edge Function のメモリと時間を使い切ると、**配信そのものが走らなくなる。**
 * 残りは翌日の実行が拾う（毎日走るので、放置され続けることは無い）。
 */
const SWEEP_LIMIT = 500;

/**
 * `dispatch` 列に書く値。**再開のときに daily と weekly を取り違えない**ため、
 * どの実行として組み立てた deps かを引数で受け取る（発注 ⑥J-4）。
 */
export function buildDeps(kind: DispatchKind): DispatchDeps {
  const kindOf = () => kind;
  const supabase = getSupabaseAdmin();
  // `listTargets` が立て、`runDispatch` が読む。**取り切れなかった事実を持ち帰る**
  let truncated = false;
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  return {
    // **環境変数はここで1回だけ読む。** 判断（`planCompany`）に環境変数を持ち込まない
    enforceEntitlement: (Deno.env.get("SENTIO_ENFORCE_ENTITLEMENT") ?? "").trim() === "true",

    get targetsTruncated(): boolean {
      return truncated;
    },

    listTargets: async (): Promise<CompanyTarget[]> => {
      // **全ページ取る**（発注 B-5）。1ページ固定だと、会社が 200 を超えた日から
      // **超えたぶんに毎朝1通も届かない。しかもその事実がどこにも残らない。**
      // 取り切れなかったときは `targetsTruncated` を立て、呼び出し側が non-2xx にする
      const users: Array<{ id: string; email?: string | null; user_metadata?: unknown }> = [];
      let page = 1;
      truncated = false;

      // 上限は「会社数の想定 × 余裕」ではなく**回数**で持つ。
      // 無限ループにしないための止め具であり、ここに当たったら取り切れていない
      for (; page <= MAX_TARGET_PAGES; page++) {
        const { data, error } = await supabase.auth.admin.listUsers({
          page,
          perPage: TARGET_PAGE_SIZE,
        });
        if (error) throw new Error(`dispatch: auth ユーザー一覧の取得に失敗: ${error.message}`);

        const batch = data?.users ?? [];
        users.push(...batch);
        if (batch.length < TARGET_PAGE_SIZE) break;
      }

      if (page > MAX_TARGET_PAGES) {
        // **黙って一部だけ配らない。** 取り切れなかった事実を持ち帰る
        console.error(
          `[sentio:dispatch] 会社の一覧を取り切れなかった pages=${MAX_TARGET_PAGES} ` +
            `per_page=${TARGET_PAGE_SIZE}`,
        );
        truncated = true;
      }

      const data = { users };

      // 連携の状態は provider ごとではなく**会社ごとに1つへ畳む**（CD-D3 の後継）。
      // **`active` が1つでもあれば `active`。** 無ければ revoked / reauth_required を拾う
      const connections = await mustData(
        supabase.from("connections").select("company_id, status"),
        "dispatch: connections",
      );

      const stateByCompany = new Map<string, ConnectionState>();
      for (const c of connections) {
        const companyId = c.company_id as string;
        const status = c.status as string;
        const current = stateByCompany.get(companyId);
        if (current === "active") continue;
        if (status === "active") stateByCompany.set(companyId, "active");
        else if (status === "revoked" || status === "reauth_required") {
          stateByCompany.set(companyId, status);
        }
        // `pending` とその他は畳まない。**関門を開ける対象ではない**（PS-9a）
      }

      // 直近の「再連携のお願い」を1回の照会で引く（PS-9e の7日判定に使う）。
      // **送信済み（sent）だけを見る。** 予約止まり（sending）や失敗を「送った」と読まない
      const notices = await mustData(
        supabase
          .from("delivery_log")
          .select("company_id, created_at")
          .eq("delivery_type", "reconnect")
          .eq("status", "sent")
          .order("created_at", { ascending: false }),
        "dispatch: reconnect notices",
      );

      const lastNotice = new Map<string, string>();
      for (const n of notices) {
        const companyId = n.company_id as string;
        if (!lastNotice.has(companyId)) lastNotice.set(companyId, n.created_at as string);
      }

      // 検知日時は `connection_events` の**遷移そのもの**から引く（PS-S4 の差し込み）。
      // `connections.revoked_at` は再連携で NULL に戻るうえ、`reauth_required` には
      // 対応する列が無い。**遷移の記録だけが両方を持っている**
      const transitions = await mustData(
        supabase
          .from("connection_events")
          .select("company_id, to_status, occurred_at")
          .in("to_status", ["revoked", "reauth_required"])
          .order("occurred_at", { ascending: false }),
        "dispatch: connection events",
      );

      const detectedAt = new Map<string, string>();
      for (const t of transitions) {
        const companyId = t.company_id as string;
        if (!detectedAt.has(companyId)) detectedAt.set(companyId, t.occurred_at as string);
      }

      return (data?.users ?? []).map((user) => ({
        companyId: user.id,
        email: user.email ?? null,
        connectionState: stateByCompany.get(user.id) ?? "none",
        lastReconnectNoticeAt: lastNotice.get(user.id) ?? null,
        detectedAt: detectedAt.get(user.id) ?? null,
        // 購読の状態（B-4）。**正本は webhook が書く `user_metadata` だけ**で、
        // ここでも Stripe には問い合わせない（BU-D2 と同じ判断）
        subscriptionStatus: subscriptionStatusOf(user.user_metadata),
      }));
    },

    invoke: async (fn: string, body: Record<string, unknown>): Promise<InvokeResult> => {
      // **返ってこない相手で全体を道連れにしない**（発注 ⑥J-4）。
      // 1社が固まると、後ろの会社が全員届かなくなる。90秒で切って次へ進む
      try {
        // `run-sense` が `scan` を呼ぶのと同じ作法（service_role で internal 経路に入る）
        const res = await fetch(`${supabaseUrl}/functions/v1/${fn}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceRoleKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(COMPANY_TIMEOUT_MS),
        });

        // **本文は読まない。** 失敗時の本文には会社の活動データが乗りうる（S-3-5 と同じ理由）
        return { ok: res.ok, status: res.status };
      } catch (e) {
        const timedOut = e instanceof DOMException && e.name === "TimeoutError";
        console.error(
          `dispatch: ${fn} の呼び出しが${timedOut ? "時間切れ" : "失敗"}: ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
        // **0 は「返事が無かった」**。HTTP の状態コードと衝突しない値にしてある
        return { ok: false, status: 0 };
      }
    },

    /**
     * 会社ごとの行を `pending` で先に書く（発注 ⑥J-4）。**冪等。**
     *
     * 00043 の一意索引 `(dispatch, run_key, company_id)` があるので、
     * 同じ実行を何度叩いても行は増えない。`ignoreDuplicates` で
     * **既にある行を pending へ戻さない**——終わった会社をやり直させない
     */
    reservePending: async (runKey: string, companyIds: string[]) => {
      if (companyIds.length === 0) return { ok: true };
      const error = await takeError(
        supabase.from("dispatch_runs").upsert(
          companyIds.map((companyId) => ({
            kind: "company",
            dispatch: kindOf(),
            company_id: companyId,
            outcome: "pending",
            run_key: runKey,
          })),
          { onConflict: "dispatch,run_key,company_id", ignoreDuplicates: true },
        ),
        "dispatch: pending の予約",
      );
      return error ? { ok: false, error: error.message } : { ok: true };
    },

    /** 1社の結末をその場で確定する（発注 ⑥J-4） */
    finishCompany: async (
      runKey: string,
      companyId: string,
      outcome: string,
      reason?: string,
      finished = true,
    ) => {
      const error = await takeError(
        supabase
          .from("dispatch_runs")
          .update({
            outcome,
            reason: reason ?? null,
            // **時間切れは終わっていない。** `finished_at` を入れると再開が拾えない
            finished_at: finished ? new Date().toISOString() : null,
          })
          .eq("kind", "company")
          .eq("dispatch", kindOf())
          .eq("run_key", runKey)
          .eq("company_id", companyId),
        "dispatch: 結末の確定",
      );
      return error ? { ok: false, error: error.message } : { ok: true };
    },

    /**
     * まだ終わっていない会社を引く（発注 ⑥J-4）。
     *
     * **引けなければ `null`。** 「全部終わっている」と「引けなかった」を
     * 同じ顔にすると、再開が黙って何もしなくなる
     */
    listUnfinished: async (runKey: string) => {
      try {
        const rows = await mustData(
          supabase
            .from("dispatch_runs")
            .select("company_id, outcome, finished_at")
            .eq("kind", "company")
            .eq("dispatch", kindOf())
            .eq("run_key", runKey),
          "dispatch: 未処理の会社",
        );
        return planResume((rows ?? []) as unknown as ResumeRow[]);
      } catch (e) {
        console.error("dispatch: 未処理の会社を引けなかった:", e instanceof Error ? e.message : e);
        return null;
      }
    },

    /**
     * `sending` のまま固まった行を掃除する（発注 B-1 / B-3）。
     *
     * **判断は `planStaleSweep` が持つ。** ここは引いて書くだけにしてある——
     * 「どの行を倒すか」を I/O に混ぜると、壊して赤くする試験が書けなくなる。
     *
     * 引く範囲を `sending` に絞るのは、**それ以外を1行も触らないため**である。
     * 2時間の判定は `planStaleSweep` が `created_at` を見て行う。
     */
    sweepStaleSending: async (now: Date) => {
      // **引けなかったことを 0件と混ぜない**（`countBillingUnresolved` と同じ作法）。
      // `mustData` は throw するので、ここで捕まえて値に落とす
      let rows: StaleRow[];
      try {
        rows = (await mustData(
          supabase
            .from("delivery_log")
            .select("id, status, attempts, created_at")
            .eq("status", "sending")
            .limit(SWEEP_LIMIT),
          "dispatch: sending の行を引く",
        )) as unknown as StaleRow[];
      } catch (e) {
        return { swept: 0, abandoned: 0, error: e instanceof Error ? e.message : String(e) };
      }

      const plan = planStaleSweep(rows, now);
      const at = now.toISOString();

      // **倒す側から先に書く。** ここで落ちても、諦めた行は次の実行で拾い直せる
      if (plan.retry.length > 0) {
        const e = await takeError(
          supabase
            .from("delivery_log")
            .update({ status: "failed", last_error: STALE_SENDING, last_error_at: at })
            .in("id", plan.retry),
          "dispatch: stale sending を failed に倒す",
        );
        if (e) return { swept: 0, abandoned: 0, error: e.message };
      }

      if (plan.abandon.length > 0) {
        const e = await takeError(
          supabase
            .from("delivery_log")
            .update({ status: ABANDONED, last_error: STALE_SENDING, last_error_at: at })
            .in("id", plan.abandon),
          "dispatch: 上限到達を abandoned に移す",
        );
        // **倒したぶんは倒した、と数える。** 諦めた側の失敗で全部を0件にしない
        if (e) return { swept: plan.retry.length, abandoned: 0, error: e.message };
      }

      return { swept: plan.retry.length, abandoned: plan.abandon.length };
    },


    /**
     * 実行の記録を書く（PS-8）。**まとめて1回の insert にする。**
     *
     * `takeError` で値にして返すのは、**記録の失敗で配信を 5xx にしない**ため。
     * 送れたのに 5xx を返すと、cron から見て「失敗した」ことになる。
     */
    recordDispatch: async (rows: DispatchRecord[]): Promise<{ ok: boolean; error?: string }> => {
      if (rows.length === 0) return { ok: true };

      const error = await takeError(
        supabase.from("dispatch_runs").insert(
          rows.map((r) =>
            r.kind === "run"
              ? {
                  kind: "run",
                  dispatch: r.dispatch,
                  company_id: null,
                  outcome: null,
                  companies: r.companies,
                  reason: null,
                }
              : {
                  kind: "company",
                  dispatch: r.dispatch,
                  company_id: r.companyId,
                  outcome: r.outcome,
                  companies: null,
                  reason: r.reason ?? null,
                },
          ),
        ),
        "dispatch: dispatch_runs",
      );

      return error ? { ok: false, error: error.message } : { ok: true };
    },

    /**
     * 未対処の行だけを数える（④-a）。`resolved_at` が埋まった行は数えない
     * ——数え続けると、1件入った日から毎日同じ通知が永久に出続ける。
     *
     * **例外を投げずに null を返す。** ここで throw すると、集計の失敗が
     * ディスパッチ全体を落として「配信が失敗した」ように見える。
     * 見分けがつかなくなるくらいなら、失敗を値にして summary に出す。
     */
    countBillingUnresolved: async (): Promise<BillingCounts | null> => {
      const staleBefore = new Date(
        Date.now() - STRIPE_RETRY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();

      try {
        const [unresolved, resolved, stale] = await Promise.all([
          mustCount(
            supabase
              .from("billing_webhook_unresolved")
              .select("stripe_event_id", { count: "exact", head: true })
              .is("resolved_at", null),
            "dispatch: billing_webhook_unresolved (unresolved)",
          ),
          // **解決済みは集計（＝通知の判断）から外すが、件数は消さない**（④-a・2-4）
          mustCount(
            supabase
              .from("billing_webhook_unresolved")
              .select("stripe_event_id", { count: "exact", head: true })
              .not("resolved_at", "is", null),
            "dispatch: billing_webhook_unresolved (resolved)",
          ),
          // **再送が尽きた見込みの行。** 「まだ望みがある」と混ぜない
          mustCount(
            supabase
              .from("billing_webhook_unresolved")
              .select("stripe_event_id", { count: "exact", head: true })
              .is("resolved_at", null)
              .lt("created_at", staleBefore),
            "dispatch: billing_webhook_unresolved (stale)",
          ),
        ]);

        return { unresolved, resolved, stale };
      } catch (e) {
        console.error(
          "dispatch: 未解決の課金 webhook を数えられなかった:",
          e instanceof Error ? e.message : "unknown",
        );
        return null;
      }
    },

    /**
     * 運用宛に1通出す。**件数だけを書く。**
     *
     * customer id もイベントIDも載せない。宛先の外に識別子を出す必要が無く、
     * 中身は `billing_webhook_unresolved` を引けば分かる（CD-2-3 と同じ考え方）。
     *
     * **`delivery_log` には記録しない。** あれは company_id が必須で、
     * 会社に紐づかない運用通知は入れられない。二重送信の心配も無い
     * （1日1回の cron からしか呼ばれない）。
     */
    notifyOpsBillingUnresolved: async (count: number): Promise<OpsNotifyResult> => {
      const to = (Deno.env.get("SENTIO_OPS_EMAIL") ?? "").trim();
      if (!to) return { ok: false, reason: "not_configured", error: "SENTIO_OPS_EMAIL 未設定" };

      const mail = resolveMailConfig();
      if (!mail.ok) {
        return { ok: false, reason: "not_configured", error: `未設定: ${mail.missing.join(", ")}` };
      }

      const subject = `[Sentio] 会社を引けなかった課金通知が ${count} 件`;
      const text = [
        `会社を引けなかった、または Stripe から取り直せなかった課金 webhook が ${count} 件あります。`,
        "",
        "該当行: public.billing_webhook_unresolved（resolved_at IS NULL）",
        "対処手順: docs/runbooks/2026-09-07_billing-webhook-unresolved.md",
        "",
        "対処が済んだら resolved_at を埋めてください。埋めるまで毎日この通知が出ます。",
        "（再送で直った行は webhook 側が自動で resolved_at を埋めます）",
      ].join("\n");

      const outcome = await sendEmail(mail.config, {
        to,
        subject,
        html: text.replace(/\n/g, "<br>"),
        text,
      });

      return outcome.ok ? { ok: true } : { ok: false, reason: "send_failed", error: outcome.error };
    },
  };
}
