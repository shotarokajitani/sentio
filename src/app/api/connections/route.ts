import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function GET(req: NextRequest) {
  const companyId = req.nextUrl.searchParams.get("company_id");
  if (!companyId) {
    return NextResponse.json({ error: "company_id required" }, { status: 400 });
  }

  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  // Fetch connections
  const { data: connections } = await supabase
    .from("connections")
    .select("provider, status, last_refresh, expires_at")
    .eq("company_id", companyId);

  // source別のイベント件数。
  // 以前は get_event_counts RPC を先に試していたが、この関数はマイグレーションに
  // 定義が無く、毎回「関数が無い」エラーを1往復ぶん出してからフォールバックしていた。
  // 常に失敗する経路なので削除し、直接カウントに一本化する。
  const counts: Record<string, number> = {};
  for (const source of ["google_calendar", "csv:accounting", "freee"]) {
    const { count } = await supabase
      .from("events")
      .select("*", { count: "exact", head: true })
      .eq("company_id", companyId)
      .eq("source", source);
    counts[source] = count ?? 0;
  }

  return NextResponse.json({ connections: connections ?? [], counts });
}
