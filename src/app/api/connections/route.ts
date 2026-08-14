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

  // Fetch event counts per source
  const { data: eventCounts } = await supabase.rpc("get_event_counts", {
    p_company_id: companyId,
  });

  // Fallback: count directly if RPC doesn't exist
  const counts: Record<string, number> = {};
  if (eventCounts) {
    for (const row of eventCounts as { source: string; count: number }[]) {
      counts[row.source] = row.count;
    }
  } else {
    // Direct query fallback
    for (const source of ["google_calendar", "csv:accounting", "freee"]) {
      const { count } = await supabase
        .from("events")
        .select("*", { count: "exact", head: true })
        .eq("company_id", companyId)
        .eq("source", source);
      counts[source] = count ?? 0;
    }
  }

  return NextResponse.json({ connections: connections ?? [], counts });
}
