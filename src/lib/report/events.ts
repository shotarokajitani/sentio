import type { SupabaseClient } from "@supabase/supabase-js";
import {
  jstWeekRange,
  summarizeWeek,
  MEETING_EVENT_TYPE,
  MEETING_SOURCE,
  type EventRow,
  type WeeklySummary,
} from "./weekly";

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
  // 前週比のために前週の頭から取る。集計側が同じ週の切り方でもう一度回す（W-D3）
  const from = jstWeekRange(new Date(week.start.getTime() - 1)).start;

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

  return summarizeWeek((data ?? []) as EventRow[], reference);
}
