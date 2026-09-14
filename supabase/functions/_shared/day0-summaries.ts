/**
 * Day0 のプロンプトに入れるデータの要約（`day0/index.ts` から切り出した・2026-09-13 の点検・PR-3 の 21）。
 *
 * **切り出したのは、プロンプトに実際に何が渡るかを試験で見るため**である。
 * `day0/index.ts` は import すると `Deno.serve` が走るので、試験から関数を呼べなかった。
 *
 * 予定の題名・会議相手のドメイン・法人名・補助金の題名は利用者由来または外部の値なので、
 * `fenceUntrusted`（制御文字の除去・80 文字・区切り）を通してから文字列に入れる。
 */
import { SITE_DESCRIPTION_MAX_CHARS, fenceUntrusted } from "./prompt-safety.ts";

export function summarizeCalendar(events: Record<string, unknown>[]): string {
  const calEvents = events.filter((e) => e.event_type === "schedule");
  if (calEvents.length === 0) return "カレンダーデータなし";

  const titles = calEvents.map(
    // **予定の題名は利用者由来。囲んでから載せる**（2026-09-13 の点検・PR-3 の 17 と 21）
    (e) => fenceUntrusted(((e.metrics as Record<string, unknown>)?.title as string) || "(無題)"),
  );
  const dates = calEvents.map((e) => (e.occurred_at as string).split("T")[0]);

  // Meeting partner analysis
  const partnerCounts: Record<string, number> = {};
  for (const e of calEvents) {
    const m = e.metrics as Record<string, unknown>;
    const attendees = (m?.attendees as string[]) || [];
    for (const a of attendees) {
      const domain = a.split("@")[1];
      if (domain) partnerCounts[domain] = (partnerCounts[domain] || 0) + 1;
    }
  }
  const topPartners = Object.entries(partnerCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([domain, count]) => `${fenceUntrusted(domain)}: ${count}件`);

  // Time distribution
  const monthCounts: Record<string, number> = {};
  for (const d of dates) {
    const month = d.substring(0, 7);
    monthCounts[month] = (monthCounts[month] || 0) + 1;
  }

  const earliest = dates[dates.length - 1];
  const latest = dates[0];

  return `全${calEvents.length}件（${earliest}〜${latest}）
月別分布: ${Object.entries(monthCounts)
    .map(([m, c]) => `${m}: ${c}件`)
    .join("、")}
予定タイトル例: ${titles.slice(0, 5).join("、")}
会議相手ドメイン: ${topPartners.length > 0 ? topPartners.join("、") : "出席者情報なし"}`;
}

export function summarizeTransactions(events: Record<string, unknown>[]): string {
  const txEvents = events.filter((e) => e.event_type === "transaction");
  if (txEvents.length === 0) return "入出金データなし";

  let totalCredit = 0,
    totalDebit = 0;
  let creditCount = 0,
    debitCount = 0;
  let maxCredit = 0,
    maxDebit = 0;
  const dates: string[] = [];

  for (const e of txEvents) {
    const m = e.metrics as Record<string, unknown>;
    const amount = (m?.amount as number) || 0;
    const direction = m?.direction as string;
    dates.push((e.occurred_at as string).split("T")[0]);

    if (direction === "credit" || amount > 0) {
      const absAmt = Math.abs(amount);
      totalCredit += absAmt;
      creditCount++;
      if (absAmt > maxCredit) maxCredit = absAmt;
    }
    if (direction === "debit" || amount < 0) {
      const absAmt = Math.abs(amount);
      totalDebit += absAmt;
      debitCount++;
      if (absAmt > maxDebit) maxDebit = absAmt;
    }
  }

  const earliest = dates[dates.length - 1];
  const latest = dates[0];

  // Monthly breakdown
  const monthlyNet: Record<string, { credit: number; debit: number }> = {};
  for (const e of txEvents) {
    const m = e.metrics as Record<string, unknown>;
    const amount = Math.abs((m?.amount as number) || 0);
    const direction = m?.direction as string;
    const month = (e.occurred_at as string).substring(0, 7);
    if (!monthlyNet[month]) monthlyNet[month] = { credit: 0, debit: 0 };
    if (direction === "credit") monthlyNet[month].credit += amount;
    else monthlyNet[month].debit += amount;
  }

  const fmt = (n: number) => n.toLocaleString("ja-JP");

  return `全${txEvents.length}件（${earliest}〜${latest}）
入金: ${creditCount}件・合計¥${fmt(totalCredit)}・最大¥${fmt(maxCredit)}
出金: ${debitCount}件・合計¥${fmt(totalDebit)}・最大¥${fmt(maxDebit)}
月別:
${Object.entries(monthlyNet)
  .map(
    ([m, v]) =>
      `  ${m}: 入金¥${fmt(v.credit)} / 出金¥${fmt(v.debit)} / 差引¥${fmt(v.credit - v.debit)}`,
  )
  .join("\n")}`;
}

export function summarizeGbiz(events: Record<string, unknown>[]): string {
  const gbiz = events.filter((e) => (e.source as string)?.includes("gbizinfo"));
  if (gbiz.length === 0) return "";

  return gbiz
    .map((e) => {
      const m = e.metrics as Record<string, unknown>;
      // 法人名・補助金の題名は外部の値。**囲んでから載せる**（PR-3 の 21）
      if (m.type === "subsidy")
        return `補助金採択: ${fenceUntrusted(m.company_name)} — ${fenceUntrusted(m.title)}`;
      if (m.type === "certification")
        return `認定: ${fenceUntrusted(m.company_name)} — ${fenceUntrusted(m.title)}`;
      if (m.type === "corporate_info")
        return `法人情報: ${fenceUntrusted(m.name)}（${m.location ? fenceUntrusted(m.location) : "所在地不明"}）`;
      return JSON.stringify(m);
    })
    .join("\n");
}

/**
 * 外部サイトの解析の結果を、プロンプトに載せる形にする（#134 の検収で決定）。
 *
 * **外部サイトは誰でも書ける。** `<title>` や meta description に指示の形をした文を置けば、
 * そのまま Day0 のプロンプトに入っていた。題名（title・H1・og:title）は 80 文字、
 * 説明文（description・og:description）は 300 文字で囲む。**取れなかった値は null のまま返す**
 * （呼び出し側が「取得不可」「なし」を出す）。
 */
export function siteAnalysisForPrompt(site: Record<string, string | null>): {
  title: string | null;
  description: string | null;
  h1: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
} {
  const title = (v: string | null | undefined) => (v ? fenceUntrusted(v) : null);
  const text = (v: string | null | undefined) =>
    v ? fenceUntrusted(v, SITE_DESCRIPTION_MAX_CHARS) : null;
  return {
    title: title(site.title),
    description: text(site.description),
    h1: title(site.h1),
    ogTitle: title(site.ogTitle),
    ogDescription: text(site.ogDescription),
  };
}
