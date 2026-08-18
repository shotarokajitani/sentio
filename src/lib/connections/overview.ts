import type { SupabaseClient } from "@supabase/supabase-js";

// 画面が件数を出す取り込み元。ここに無い source は表示対象外
export const COUNTED_SOURCES = ["google_calendar", "csv:accounting", "freee"] as const;

export interface ConnectionRow {
  provider: string;
  status: string;
  last_refresh: string | null;
  expires_at: string | null;
}

export interface ConnectionOverview {
  connections: ConnectionRow[];
  counts: Record<string, number>;
}

/**
 * 自社の接続状態と取り込み件数をまとめて返す。
 *
 * 画面（Server Component）とAPIの両方がここを通る。同じ問い合わせを二重に書くと、
 * 片方だけRLSクライアントを使い忘れる事故が起きる。
 */
export async function fetchConnectionOverview(
  supabase: SupabaseClient,
  companyId: string,
): Promise<ConnectionOverview | null> {
  const { data, error } = await supabase
    .from("connections")
    .select("provider, status, last_refresh, expires_at")
    .eq("company_id", companyId);

  if (error) {
    console.error("connections 取得に失敗:", error.message);
    return null;
  }

  const counts: Record<string, number> = {};
  for (const source of COUNTED_SOURCES) {
    const { count, error: countError } = await supabase
      .from("events")
      .select("*", { count: "exact", head: true })
      .eq("company_id", companyId)
      .eq("source", source);

    if (countError) {
      console.error(`events 件数の取得に失敗 (${source}):`, countError.message);
      return null;
    }
    counts[source] = count ?? 0;
  }

  return { connections: (data ?? []) as ConnectionRow[], counts };
}
