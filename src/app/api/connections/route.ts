import { NextResponse } from "next/server";
import { getAuthedContext, unauthorized } from "@/lib/auth/company";
import { fetchConnectionOverview } from "@/lib/connections/overview";

/**
 * 自社の接続状態とイベント件数を返す。
 *
 * 引数を取らないのは意図的で、company_id を外から受け取る経路を構造的に無くしている。
 * 以前は company_id をクエリパラメータで受け取り service_role で読んでいたため、
 * company_id を知る第三者が任意の会社の接続状態を取得できた（07_open_items §1）。
 */
export async function GET() {
  const ctx = await getAuthedContext();
  if (!ctx) return unauthorized();

  const overview = await fetchConnectionOverview(ctx.supabase, ctx.companyId);
  if (!overview) {
    return NextResponse.json({ error: "fetch_failed" }, { status: 500 });
  }

  return NextResponse.json(overview);
}
