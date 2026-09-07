/**
 * ディスパッチャの実行時配線（契約 スライスCD）。
 *
 * 判断は `_shared/dispatch.ts` の純ロジックに閉じてある。ここは
 * **Supabase と fetch を繋ぐだけ**である。`dispatch-daily` と `dispatch-weekly` で
 * 同じ配線を2回書くと、片方だけ直したときに宛先の取り方が割れる。
 */

import { getSupabaseAdmin } from "./supabase-client.ts";
import { mustCount, mustData } from "./db.ts";
import { resolveMailConfig, sendEmail } from "./mailer.ts";
import { STRIPE_RETRY_WINDOW_DAYS } from "./dispatch.ts";
import type {
  BillingCounts,
  CompanyTarget,
  DispatchDeps,
  InvokeResult,
  OpsNotifyResult,
} from "./dispatch.ts";

/**
 * 宛先の正本は `auth.users.email`（CD-D1）。**新しいテーブルを作らない。**
 *
 * RLS ポリシー（`00019`）が `company_id = auth.uid()` なので、
 * 会社とアカウントは 1:1 である（`src/lib/auth/company.ts` と同じ前提）。
 * したがって `auth.users.id` がそのまま `company_id` になる。
 */
export function buildDeps(): DispatchDeps {
  const supabase = getSupabaseAdmin();
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  return {
    listTargets: async (): Promise<CompanyTarget[]> => {
      // service_role でのみ引ける。ページングの上限は当面の会社数から余裕を見た固定値
      const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
      if (error) throw new Error(`dispatch: auth ユーザー一覧の取得に失敗: ${error.message}`);

      // 連携の有無は provider ごとではなく会社ごとに畳む（CD-D3）
      const connections = await mustData(
        supabase.from("connections").select("company_id, status"),
        "dispatch: connections",
      );
      const connected = new Set(
        connections.filter((c) => c.status === "active").map((c) => c.company_id as string),
      );

      return (data?.users ?? []).map((user) => ({
        companyId: user.id,
        email: user.email ?? null,
        hasConnection: connected.has(user.id),
      }));
    },

    invoke: async (fn: string, body: Record<string, unknown>): Promise<InvokeResult> => {
      // `run-sense` が `scan` を呼ぶのと同じ作法（service_role で internal 経路に入る）
      const res = await fetch(`${supabaseUrl}/functions/v1/${fn}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        body: JSON.stringify(body),
      });

      // **本文は読まない。** 失敗時の本文には会社の活動データが乗りうる（S-3-5 と同じ理由）
      return { ok: res.ok, status: res.status };
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
