// State-baselines Edge Function — reads events, calculates baselines, upserts
// LLM-free, deterministic recalculation (nightly via pg_cron)

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { resolveCaller, resolveCompanyId } from "../_shared/caller.ts";
import { mustData, mustOk, errorResponse } from "../_shared/db.ts";
import {
  BASELINE_NATURAL_KEY,
  INFLOW_BASELINE,
  OUTFLOW_BASELINE,
  REVENUE_BASELINE,
  splitByDirection,
  SCHEDULE_INTERVAL_BASELINE,
  buildBaselineStats,
  scheduleDayIntervals,
} from "../_shared/baseline-stats.ts";

const MIN_OBS = 5;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 呼び出し元の判定は DBに触る前（契約 S-2-9）
  const caller = await resolveCaller(req);
  if (!caller.ok) return caller.response;

  try {
    const body = await req.json();
    const { company_id: bodyCompanyId } = body;
    // **源ごとに更新するかを決める**（PS-9c の改訂）。渡されなければ従来どおり全部
    const live: string[] | null = Array.isArray(body.live_sources) ? body.live_sources : null;
    const runCash = live === null || live.includes("csv:accounting") || live.includes("freee");
    const runSchedule = live === null || live.includes("google_calendar");

    const scope = resolveCompanyId(caller.caller, bodyCompanyId);
    if (!scope.ok) return scope.response;
    const company_id = scope.companyId;

    const supabase = getSupabaseAdmin();

    // **止まっている源の平常値は更新しない**（PS-9c の改訂）。
    // 空の観測で upsert すると、**既存の平常値を空で上書きする。**
    // 取り込みが戻った日に平常値が無く、何日も判断できなくなる
    // 応答に出すので、条件の外で持つ。**更新しなかった源は null を返す**
    let isEstablished: boolean | null = null;
    let observationCount: number | null = null;
    if (runCash) {
      // **止まっている源の平常値は更新しない。** 古い観測で平常値を作り直すと、
      // 取り込みが戻った日に「いつもと違う」が大量に出る
      // Fetch transaction events for this company
      const events = await mustData(
        supabase
          .from("events")
          .select("event_id, occurred_at, event_type, metrics")
          .eq("company_id", company_id)
          .eq("event_type", "transaction")
          .order("occurred_at", { ascending: true }),
        "state-baselines: events",
      );

      // **`metrics.revenue` は本番のどのイベントにも存在しない**（発注 E-3）。
      // 実物は `amount` / `direction` なので、向きで分けてから絶対値で集める。
      // 混ぜると中央値が0の近くに寄って、走査1が何も検知しなくなる
      const { inflow, outflow } = splitByDirection(events || []);
      // `revenue` の分は**残す**。過去に書いた行があり、消すと観測の履歴が読めなくなる
      const revenues = (events || [])
        .map((e) => (e.metrics as Record<string, unknown>)?.revenue as number)
        .filter((v): v is number => typeof v === "number");

      // 統計は `stats` JSONB に入れる。**修復前はここが median / iqr / p25 / p75 /
      // observation_count を「列として」書いており、実スキーマに存在しないため
      // PGRST204 になっていた**（P-1）。計算はアダプタ1本に寄せてある（S-1-2）
      const stats = buildBaselineStats(revenues, MIN_OBS);
      isEstablished = stats !== null;
      observationCount = revenues.length;

      await mustOk(
        supabase.from("baselines").upsert(
          {
            company_id,
            metric_key: REVENUE_BASELINE.metricKey,
            // 自然キーの一部なので明示する。省略するとキーの意味が変わる
            entity_id: REVENUE_BASELINE.entityId,
            granularity: REVENUE_BASELINE.granularity,
            // 確立していないときは stats を空にする。数字を 0 で埋めない
            // （読み側の parseBaselineStats が null にして落とす）
            stats: stats ?? {},
            min_obs: MIN_OBS,
            is_established: isEstablished,
            updated_at: new Date().toISOString(),
          },
          { onConflict: BASELINE_NATURAL_KEY },
        ),
        "state-baselines: baselines upsert",
      );

      // ── 入金・出金（発注 E-3）──
      //
      // **走査1が読む鍵をここで作る。** 検出器とベースラインは対で要る。
      // `revenue` を読んでいた間、両側とも本番に存在しない鍵を見ていた
      for (const [decl, values] of [
        [INFLOW_BASELINE, inflow],
        [OUTFLOW_BASELINE, outflow],
      ] as const) {
        const s = buildBaselineStats(values, MIN_OBS);
        await mustOk(
          supabase.from("baselines").upsert(
            {
              company_id,
              metric_key: decl.metricKey,
              entity_id: decl.entityId,
              granularity: decl.granularity,
              stats: s ?? {},
              min_obs: MIN_OBS,
              is_established: s !== null,
              updated_at: new Date().toISOString(),
            },
            { onConflict: BASELINE_NATURAL_KEY },
          ),
          `state-baselines: ${decl.metricKey} upsert`,
        );
      }
    }

    // ── 予定の発生間隔（途絶＝沈黙シグナルの土台）──
    //
    // **検出器だけでは動かない。** `scan` の途絶走査はこのベースラインが
    // 成立していなければ何もしない（抑制①「ベースライン未成立は対象外」）。
    // 2026-08-31 の時点で `schedule_interval` を作る場所はどこにも無く、
    // 走査を足しても一度も発火しない状態だった。ここが対になる半分である。
    // **カレンダーが止まっていたら、予定の平常値は更新しない**（PS-9c の改訂）。
    // 空の観測で upsert すると既存の平常値を空で上書きし、
    // 再連携した日に途絶の判断が何日もできなくなる
    let intervalCount: number | null = null;
    let intervalEstablished: boolean | null = null;
    if (runSchedule) {
      const scheduleEvents = await mustData(
        supabase
          .from("events")
          .select("occurred_at")
          .eq("company_id", company_id)
          .eq("event_type", "schedule")
          .order("occurred_at", { ascending: true }),
        "state-baselines: schedule events",
      );

      const intervals = scheduleDayIntervals(
        (scheduleEvents || []).map((e) => e.occurred_at as string),
      );
      const intervalStats = buildBaselineStats(intervals, MIN_OBS);

      await mustOk(
        supabase.from("baselines").upsert(
          {
            company_id,
            metric_key: SCHEDULE_INTERVAL_BASELINE.metricKey,
            entity_id: SCHEDULE_INTERVAL_BASELINE.entityId,
            granularity: SCHEDULE_INTERVAL_BASELINE.granularity,
            stats: intervalStats ?? {},
            min_obs: MIN_OBS,
            is_established: intervalStats !== null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: BASELINE_NATURAL_KEY },
        ),
        "state-baselines: schedule_interval upsert",
      );
      intervalCount = intervals.length;
      intervalEstablished = intervalStats !== null;
    }

    return new Response(
      JSON.stringify({
        status: "ok",
        company_id,
        // **更新しなかった源は null。** false と書くと「確立していない」と読まれる
        is_established: isEstablished,
        observation_count: observationCount,
        updated_sources: { cash: runCash, schedule: runSchedule },
        schedule_interval: {
          is_established: intervalEstablished,
          observation_count: intervalCount,
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    return errorResponse(error, corsHeaders);
  }
});
