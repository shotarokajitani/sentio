// retention-purge — 保持期間を過ぎたイベントを削除する定期処理
//
// プライバシーポリシー §6（src/app/privacy/page.tsx）で
// 「Google ユーザーデータは、取得した日から24ヶ月経過した時点で削除します」と公開した。
// **書いた以上、実際に消す経路が要る。** これがその実体。
//
// 危険の向きが他の Function と違う。deliver 系の事故は「勝手に送る」だが、
// ここの事故は「消しすぎる」で、取り返しがつかない。したがって:
//   - **会社ごとに**数えてから消す（company_id 無しでは1行も消さない）
//   - 想定を超えた件数なら**その会社をスキップして続ける**（黙って消さない）
//   - 何社・何件消したかを必ず応答とログの両方に出す
//
// 起動は internal のみ。cron 登録は A-2（本スライスの後）。
// それまでは Actions の invoke-function ワークフローから手動で回す。

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { resolveCaller } from "../_shared/caller.ts";
import { mustData, mustCount, mustOk, errorResponse } from "../_shared/db.ts";
import {
  MAX_DELETE_ROWS,
  RETENTION_MONTHS,
  evaluateDeletion,
  retentionCutoff,
} from "../_shared/retention.ts";

interface CompanyPurge {
  company_id: string;
  counted: number;
  deleted: number;
  skipped_reason?: string;
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

  try {
    const supabase = getSupabaseAdmin();
    const cutoff = retentionCutoff(new Date()).toISOString();

    // **会社テーブルは存在しない。** 会社の同一性は auth.users.id が担っており、
    // auth スキーマは PostgREST から引けない。`events` を直に舐めると PostgREST の
    // 行数上限で黙って打ち切られるため、DISTINCT は DB 側の関数に持たせてある（00026）。
    // 戻るのは「期限切れの行を持つ会社」だけなので、これがそのまま作業リストになる
    const expired = await mustData<{ company_id: string }[]>(
      supabase.rpc("retention_expired_companies", { p_cutoff: cutoff }),
      "retention-purge: expired companies",
    );

    const results: CompanyPurge[] = [];
    let totalDeleted = 0;
    let blocked = 0;

    for (const { company_id: companyId } of expired) {
      const counted = await mustCount(
        supabase
          .from("events")
          .select("event_id", { count: "exact", head: true })
          .eq("company_id", companyId)
          .lt("ingested_at", cutoff),
        "retention-purge: count",
      );

      const guard = evaluateDeletion({
        companyId,
        counted,
        max: MAX_DELETE_ROWS,
      });

      if (!guard.ok) {
        // この会社は飛ばす。他社の削除まで止める理由は無いが、黙って消しもしない
        blocked += 1;
        console.warn(
          `[sentio:retention] purge を中止した company_id=${companyId} ` +
            `reason=${guard.reason} count=${guard.count} max=${MAX_DELETE_ROWS}`,
        );
        results.push({
          company_id: companyId,
          counted: guard.count,
          deleted: 0,
          skipped_reason: guard.reason,
        });
        continue;
      }

      // 00026 は期限切れの行を持つ会社しか返さないので、ここは通常通らない。
      // 通ったなら列挙と計数の間に他の経路が消したということ。異常ではないので続ける
      if (guard.count === 0) {
        results.push({ company_id: companyId, counted: 0, deleted: 0 });
        continue;
      }

      await mustOk(
        supabase.from("events").delete().eq("company_id", companyId).lt("ingested_at", cutoff),
        "retention-purge: delete",
      );

      totalDeleted += guard.count;
      results.push({ company_id: companyId, counted: guard.count, deleted: guard.count });
    }

    console.log(
      `[sentio:retention] purge 完了 cutoff=${cutoff} months=${RETENTION_MONTHS} ` +
        `companies=${expired.length} deleted=${totalDeleted} blocked=${blocked}`,
    );

    return new Response(
      JSON.stringify({
        status: "ok",
        cutoff,
        retention_months: RETENTION_MONTHS,
        // 全社数ではなく「期限切れの行を持っていた会社の数」。0 は正常（消すものが無い）
        companies: expired.length,
        deleted: totalDeleted,
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
