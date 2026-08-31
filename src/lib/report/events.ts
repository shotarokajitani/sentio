import type { SupabaseClient } from "@supabase/supabase-js";
import {
  jstWeekRange,
  summarizeWeekWithFallback,
  FALLBACK_MAX_WEEKS,
  MEETING_EVENT_TYPE,
  MEETING_SOURCE,
  type EventRow,
  type WeeklySummary,
} from "@shared/report/weekly";

/**
 * 週次レポートの読み取り口（契約 スライスW・W-D1）。
 *
 * DB に触るのはここだけで、集計そのものは `weekly.ts`（純関数）が持つ。
 * 画面（Server Component）はこの関数を1回呼ぶだけにする。
 *
 * **渡されるのは RLS が効くクライアントである**（`getAuthedContext()` 由来）。
 * service_role を渡さない。company_id の一致は DB 側でも止まるが、
 * `/connect` と同じく問い合わせ側にも明示する（W-2-2）。
 *
 * 失敗したら `null` を返す。0件（空の週）とは別物であり、
 * 画面はこの2つを別の見た目で描く（W-3-1 / W-3-2）。
 */
export async function fetchWeeklyReport(
  supabase: SupabaseClient,
  companyId: string,
  reference: Date,
): Promise<WeeklySummary | null> {
  const week = jstWeekRange(reference);
  /**
   * 取得窓は**遡り上限＋その前週**まで広げる（契約 スライスRF）。
   *
   * 当週が0件のとき最大 `FALLBACK_MAX_WEEKS` 週まで遡り（RF-D3）、
   * さらに**表示する週の前週**と比べる（RF-D5）ので、
   * 最も古い場合で「当週の9週前の週頭」まで要る。
   *
   * **週の選択はここでしない。** どの週を出すかは純関数（`summarizeWeekWithFallback`）が決める。
   * DB のクエリで週を決めると、選択規則が SQL と TypeScript に割れる。
   */
  const from = new Date(week.start.getTime() - (FALLBACK_MAX_WEEKS + 1) * 7 * DAY_MS);

  const { data, error } = await supabase
    .from("events")
    .select("source, event_type, period_start, period_end, metrics")
    .eq("company_id", companyId)
    .eq("source", MEETING_SOURCE)
    .eq("event_type", MEETING_EVENT_TYPE)
    .gte("period_start", from.toISOString())
    .lt("period_start", week.end.toISOString());

  if (error) {
    // 出席者の中身が乗りうる行データはログに出さない。理由だけを残す（契約 停止点）
    console.error("週次レポートの events 取得に失敗:", error.message);
    return null;
  }

  // 上端は当週の終わり。**未来の週は取りに行かない**（RF-D4。純関数側でも選ばない）
  return summarizeWeekWithFallback((data ?? []) as EventRow[], reference);
}

const DAY_MS = 86_400_000;
