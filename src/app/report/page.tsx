import { redirect } from "next/navigation";
import { ReportView } from "./report-view";
import { t } from "@/i18n";
import { getAuthedContext } from "@/lib/auth/company";
import { fetchWeeklyReport } from "@/lib/report/events";

export const metadata = { title: `${t.report.title} — ${t.brand}` };

/**
 * 週次レポート（契約 スライスW・W-D1）。`/connect` と同じ形にしてある。
 *
 * `getAuthedContext()` → RLS クライアント → `src/lib/report/*` → 表示コンポーネント。
 * company_id はセッションからしか取らない。クエリやボディから受け取る経路を作らない。
 *
 * 未認証は `/login` へ返す。middleware（`src/middleware.ts` の PROTECTED_PREFIXES）でも
 * 同じ判定をしており、**二重に閉じている**（W-2-3）。
 */
export default async function ReportPage() {
  const ctx = await getAuthedContext();
  if (!ctx) redirect("/login?next=%2Freport");

  // 週の切り出しは集計側が JST で行う。ここでは「いま」を渡すだけにする（W-1-1）
  const summary = await fetchWeeklyReport(ctx.supabase, ctx.companyId, new Date());

  return <ReportView summary={summary} />;
}
