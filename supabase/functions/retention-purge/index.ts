// retention-purge — 保持期間を過ぎたイベントと、取り消しから30日経った連携のデータを削除する
//
// プライバシーポリシー §6（src/app/privacy/page.tsx）で
// 「Google ユーザーデータは、取得した日から24ヶ月経過した時点で削除します」と公開した。
// **書いた以上、実際に消す経路が要る。** これがその実体。
//
// 2026-09-08 に契約D の D-3（取り消しから30日で削除）を足した。**削除は2種類ある。**
//   retention_months … `ingested_at` が24ヶ月より古い行（会社ごと）
//   revoked_grace    … `revoked_at` から30日経った連携の、その provider 由来の行
//
// 危険の向きが他の Function と違う。deliver 系の事故は「勝手に送る」だが、
// ここの事故は「消しすぎる」で、取り返しがつかない。したがって:
//   - **会社ごとに**数えてから消す（company_id 無しでは1行も消さない）
//   - 想定を超えた件数なら**その会社をスキップして続ける**（黙って消さない）
//   - 何社・何件消したかを応答とログと**レコード**の3つに残す（`retention_purge_runs`）
//   - **既定は数えるだけ**（`dry_run` を省略したら true）。消すのは明示したときだけ
//
// 起動は internal のみ。cron は `00031`（**本文は `{"dry_run": true}`**）。

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { resolveCaller } from "../_shared/caller.ts";
import { mustData, mustCount, takeError, errorResponse } from "../_shared/db.ts";
import {
  MAX_DELETE_ROWS,
  RETENTION_MONTHS,
  REVOKED_GRACE_DAYS,
  planPurge,
  reconcileDeletion,
  retentionCutoff,
  revokedCutoff,
  sourcesForProvider,
  type DeletionOutcome,
  type PurgePlan,
} from "../_shared/retention.ts";

/**
 * `getSupabaseAdmin()` が返すクライアントの型。
 *
 * **`https://esm.sh/@supabase/supabase-js` から型を import しない。**
 * `deno check` は同じバージョンでも npm 解決と esm.sh 解決を別の型として扱い、
 * `SupabaseClient` を受け取る引数で TS2345 になる（2026-09-08 CI で実測）。
 * 生成元から `ReturnType` で引けば、経路が1つに揃う。
 */
type Db = ReturnType<typeof getSupabaseAdmin>;

type PurgeKind = "run" | "retention_months" | "revoked_grace";

/**
 * 記録に残す判断。`planPurge` の結果に、**Edge 側にしか無い理由**を1つ足したもの。
 *
 * `unknown-provider`（知らない provider だったので消さずに飛ばした）は
 * 削除の門（`evaluateDeletion`）の判定ではないので、**方針モジュールには置かない。**
 * 00030 の `reason` の CHECK はこの集合と同じである。片方を変えたら両方変える。
 */
interface PurgeOutcome {
  decision: PurgePlan["decision"];
  reason?: PurgePlan["reason"] | "unknown-provider";
  count: number;
}

interface CompanyPurge {
  company_id: string | null;
  kind: PurgeKind;
  provider?: string;
  /** 消す前に数えた件数。**予定**である（dry_run で決まるのはこれだけ） */
  planned: number;
  /** DB が返した削除行数。**観測**である。試みていない・取れなかったときは null */
  observed: number | null;
  /** 記録に残す削除件数（観測値。無ければ 0） */
  deleted: number;
  /** 予定と観測が食い違ったか。**片方に寄せない** */
  mismatch: boolean;
  decision: PurgePlan["decision"];
  reason?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 呼び出し元の判定は DBに触る前（契約 S-2-9）
  const caller = await resolveCaller(req);
  if (!caller.ok) return caller.response;

  // 全社を横断して消す処理なので、利用者からは絶対に叩かせない
  if (caller.caller.kind !== "internal") {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // **既定は数えるだけ。** 本文が無い・壊れている・`dry_run` を書いていない、
  // のいずれでも消さない側に倒れる。**消すのは `{"dry_run": false}` と明示したときだけ**
  const dryRun = await resolveDryRun(req);

  try {
    const supabase = getSupabaseAdmin();
    const now = new Date();
    const cutoff = retentionCutoff(now).toISOString();
    const revokedBefore = revokedCutoff(now).toISOString();

    const results: CompanyPurge[] = [];

    // ------------------------------------------------------------------
    // 1. 保持期限（24ヶ月）
    //
    // **会社テーブルは存在しない。** 会社の同一性は auth.users.id が担っており、
    // auth スキーマは PostgREST から引けない。`events` を直に舐めると PostgREST の
    // 行数上限で黙って打ち切られるため、DISTINCT は DB 側の関数に持たせてある（00026）
    // ------------------------------------------------------------------
    const expired = await mustData<{ company_id: string }[]>(
      supabase.rpc("retention_expired_companies", { p_cutoff: cutoff }),
      "retention-purge: expired companies",
    );

    for (const { company_id: companyId } of expired) {
      const counted = await mustCount(
        supabase
          .from("events")
          .select("event_id", { count: "exact", head: true })
          .eq("company_id", companyId)
          .lt("ingested_at", cutoff),
        "retention-purge: count",
      );

      const plan = planPurge({ companyId, counted, max: MAX_DELETE_ROWS, dryRun });

      // **記録するのは観測値である。** `count: "exact"` で DB が返した行数を受け取る
      let outcome = reconcileDeletion({ planned: plan.count, observed: null, attempted: false });

      if (plan.decision === "deleted") {
        // **観測値を受け取る。** `mustCount` は行数が取れなければ 0 を返すので、
        // 予定と食い違えば下の `reconcileDeletion` が食い違いとして立てる
        const observed = await mustCount(
          supabase
            .from("events")
            .delete({ count: "exact" })
            .eq("company_id", companyId)
            .lt("ingested_at", cutoff),
          "retention-purge: delete",
        );
        outcome = reconcileDeletion({ planned: plan.count, observed, attempted: true });
      }

      results.push(
        await record(supabase, { companyId, kind: "retention_months", plan, outcome, dryRun }),
      );
    }

    // ------------------------------------------------------------------
    // 2. 取り消しから30日（契約D の D-3）
    //
    // `revoked_at` が NULL の行は `lt` に一致しないので、**繋がっている連携は
    // 構造的に対象外**である（再連携すると 00027 / D-2-6 が NULL に戻す）。
    // ------------------------------------------------------------------
    const revoked = await mustData<{ company_id: string; provider: string }[]>(
      supabase.from("connections").select("company_id, provider").lt("revoked_at", revokedBefore),
      "retention-purge: revoked connections",
    );

    for (const { company_id: companyId, provider } of revoked) {
      const sources = sourcesForProvider(provider) as string[];

      // 知らない provider を「全部消す」に丸めない。**消さずに記録して次へ**
      if (sources.length === 0) {
        console.warn(`[sentio:retention] 未知の provider を飛ばした provider=${provider}`);
        results.push(
          await record(supabase, {
            companyId,
            kind: "revoked_grace",
            provider,
            plan: { decision: "blocked", reason: "unknown-provider", count: 0 },
            // 消していないので観測は無い。**予定も0である**
            outcome: { planned: 0, observed: null, deleted: 0, mismatch: false },
            dryRun,
          }),
        );
        continue;
      }

      const counted = await mustCount(
        supabase
          .from("events")
          .select("event_id", { count: "exact", head: true })
          .eq("company_id", companyId)
          .in("source", sources),
        "retention-purge: revoked count",
      );

      const plan = planPurge({ companyId, counted, max: MAX_DELETE_ROWS, dryRun });

      let outcome = reconcileDeletion({ planned: plan.count, observed: null, attempted: false });

      if (plan.decision === "deleted") {
        const observed = await mustCount(
          supabase
            .from("events")
            .delete({ count: "exact" })
            .eq("company_id", companyId)
            .in("source", sources),
          "retention-purge: revoked delete",
        );
        outcome = reconcileDeletion({ planned: plan.count, observed, attempted: true });
      }

      results.push(
        await record(supabase, {
          companyId,
          kind: "revoked_grace",
          provider,
          plan,
          outcome,
          dryRun,
        }),
      );
    }

    const deleted = results.reduce((sum, r) => sum + r.deleted, 0);
    const planned = results.reduce((sum, r) => sum + r.planned, 0);
    const blocked = results.filter((r) => r.decision === "blocked").length;
    // **食い違いは応答にも出す。** 記録を読みに行かないと気づけない形にしない
    const mismatched = results.filter((r) => r.mismatch).length;

    // **対象が0件でも、実行そのものを1行残す。**
    // これが無いと「0件だったから記録が無い」と「cron が発火していないから記録が無い」が
    // 同じ顔になる。`retention-purge` は**cron が無くて一度も動いていなかった**関数である。
    // 動いた証跡そのものを残す。
    //
    // **例外で落ちた実行はここに来ない**（その痕跡は `net._http_response` の 5xx 側にある）
    await record(supabase, {
      kind: "run",
      plan: {
        decision: dryRun ? "dry_run" : deleted > 0 ? "deleted" : "nothing",
        count: planned,
      },
      // 実行そのものの行は、会社ごとの観測を合計したものを持つ
      outcome: { planned, observed: dryRun ? null : deleted, deleted, mismatch: mismatched > 0 },
      dryRun,
      always: true,
    });

    console.log(
      `[sentio:retention] purge 完了 dry_run=${dryRun} cutoff=${cutoff} ` +
        `revoked_before=${revokedBefore} months=${RETENTION_MONTHS} days=${REVOKED_GRACE_DAYS} ` +
        `targets=${results.length} planned=${planned} deleted=${deleted} blocked=${blocked} ` +
        `mismatched=${mismatched}`,
    );

    return new Response(
      JSON.stringify({
        status: "ok",
        // **数えるだけだったのか、消したのかを応答から区別できるようにする**
        dry_run: dryRun,
        cutoff,
        revoked_before: revokedBefore,
        retention_months: RETENTION_MONTHS,
        revoked_grace_days: REVOKED_GRACE_DAYS,
        // 全社数ではなく「対象になった（会社×種別）の数」。0 は正常（消すものが無い）
        targets: results.length,
        // **予定と観測を同じ名前で持たない**（dry_run の数字と実削除の数字は別物）
        planned,
        deleted,
        mismatched,
        // 0件で終わった理由を応答から区別できるようにする（S-2-3 と同じ考え方）
        blocked,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return errorResponse(e, corsHeaders);
  }
});

/**
 * 本文から `dry_run` を読む。**読めなければ true**（＝消さない）。
 *
 * 本番コードに `if (testMode)` を作らないための形である。
 * 分岐の材料は**引数だけ**で、環境変数もビルド時の定数も見ない。
 */
async function resolveDryRun(req: Request): Promise<boolean> {
  try {
    const body = await req.json();
    return body?.dry_run === false ? false : true;
  } catch {
    // 本文が無い cron 呼び出し（`'{}'::jsonb`）もここに来る。安全側に倒す
    return true;
  }
}

/**
 * 実行の記録を1行残し、応答用の値を返す。
 *
 * **0件（`nothing`）は記録しない。** 取り消し済みの連携は消し終わったあとも
 * `revoked_at` を持ったまま残るので、記録すると**毎日0件の行が積み上がる。**
 * 溜まったノイズの中の1件は、誰にも見つけられない。
 *
 * **記録に失敗しても削除は巻き戻さない**（もう消えている）。失敗はログに残す。
 */
async function record(
  supabase: Db,
  input: {
    /** `kind: "run"` のときだけ省く。会社に紐づかない行である */
    companyId?: string;
    kind: PurgeKind;
    provider?: string;
    plan: PurgeOutcome;
    /** 予定と観測。**削除を試みていない経路でも渡す**（観測は null になる） */
    outcome: DeletionOutcome;
    dryRun: boolean;
    /** `nothing` でも必ず記録する（実行そのものの行） */
    always?: boolean;
  },
): Promise<CompanyPurge> {
  const { companyId, kind, provider, plan, outcome, dryRun, always } = input;

  const row: CompanyPurge = {
    company_id: companyId ?? null,
    kind,
    ...(provider ? { provider } : {}),
    planned: outcome.planned,
    observed: outcome.observed,
    deleted: outcome.deleted,
    mismatch: outcome.mismatch,
    decision: plan.decision,
    ...(plan.reason ? { reason: plan.reason } : {}),
  };

  if (outcome.mismatch) {
    // **黙って片方に寄せない。** 記録には両方が残り、ログにも出る
    console.warn(
      `[sentio:retention] 数えた件数と削除行数が食い違った company_id=${companyId ?? "-"} ` +
        `kind=${kind} planned=${outcome.planned} observed=${outcome.observed ?? "取得できず"}`,
    );
  }

  if (plan.decision === "blocked") {
    // 止めた事実は**ログとレコードの両方**に残す（片方だけだと気づく経路が1本になる）
    console.warn(
      `[sentio:retention] purge を中止した company_id=${companyId ?? "-"} kind=${kind} ` +
        `reason=${plan.reason} count=${plan.count} max=${MAX_DELETE_ROWS}`,
    );
  }

  // 0件は記録しない（取り消し済みの連携は消したあとも残るので、毎日0件の行が積み上がる）。
  // **ただし実行そのものの行は例外で、必ず残す**
  if (plan.decision === "nothing" && !always) return row;

  // `takeError` を使うのは、**ここで throw すると削除済みの実行が 5xx として返る**ため。
  // 記録の失敗は削除の失敗ではない。理由を値で受けてログに残す（S-2-4 の正規形）
  const insertError = await takeError(
    supabase.from("retention_purge_runs").insert({
      company_id: companyId ?? null,
      kind,
      provider: provider ?? null,
      // 列名は `counted`（00030）。中身は**消す前に数えた件数＝予定**である
      counted: outcome.planned,
      // **観測値。** dry_run では削除していないので 0 が入る（`decision` で区別できる）
      deleted: outcome.deleted,
      decision: plan.decision,
      reason: plan.reason ?? null,
      dry_run: dryRun,
    }),
    "retention-purge: 実行記録",
  );

  if (insertError) {
    console.error("retention-purge: 実行記録の書き込みに失敗:", insertError.message);
  }

  return row;
}
