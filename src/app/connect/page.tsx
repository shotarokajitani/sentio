import { redirect } from "next/navigation";
import { ConnectClient } from "./connect-client";
import { errorMessage, t } from "@/i18n";
import { getAuthedContext } from "@/lib/auth/company";
import { fetchConnectionOverview } from "@/lib/connections/overview";

export const metadata = { title: `${t.connect.title} — ${t.brand}` };

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function ConnectPage({ searchParams }: { searchParams: Search }) {
  const ctx = await getAuthedContext();
  if (!ctx) redirect("/login?next=%2Fconnect");

  const params = await searchParams;
  const raw = params.e;
  const overview = await fetchConnectionOverview(ctx.supabase, ctx.companyId);

  // 内部コードはここで辞書に通す。生の値をクライアントへ渡さない（運用ルール§6）
  return (
    <ConnectClient
      failureMessage={errorMessage(Array.isArray(raw) ? raw[0] : raw)}
      initialOverview={overview}
      // 解除の二段確認の照合対象（U-2・2026-08-27 確定）。**セッション以外から取らない**。
      // クエリやフォームから受け取ると、照合の正本を攻撃者が指定できてしまう
      accountEmail={ctx.email}
    />
  );
}
