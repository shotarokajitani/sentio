/**
 * seed-s0.ts — S0（外部公開データ）のシードスクリプト
 *
 * Usage: pnpm tsx scripts/seed-s0.ts
 *
 * 対象データ源:
 * - e-Stat（政府統計）
 * - gBizINFO（法人基本情報）
 * - jGrants（補助金情報）
 * - 業界レポート（公開統計）
 *
 * Walking skeleton ではスタブとしてハードコード済みフィクスチャを投入。
 * 本番では各APIから取得する。
 */

const SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const SUPABASE_FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

const s0Events = [
  {
    source: "estat:gdp",
    occurred_at: "2026-03-31T00:00:00.000Z",
    metrics: {
      indicator: "GDP成長率",
      value: 1.2,
      unit: "percent",
      period: "2025Q4",
    },
  },
  {
    source: "estat:cpi",
    occurred_at: "2026-05-01T00:00:00.000Z",
    metrics: {
      indicator: "消費者物価指数",
      value: 107.3,
      unit: "index",
      base_year: 2020,
    },
  },
  {
    source: "gbizinfo:industry",
    occurred_at: "2026-04-01T00:00:00.000Z",
    metrics: {
      indicator: "情報通信業_企業数",
      value: 58000,
      unit: "count",
    },
  },
  {
    source: "jgrants:subsidy",
    occurred_at: "2026-06-01T00:00:00.000Z",
    metrics: {
      name: "IT導入補助金2026",
      max_amount: 4500000,
      deadline: "2026-09-30",
    },
  },
];

async function main() {
  if (!SUPABASE_ANON_KEY) {
    console.error("SUPABASE_ANON_KEY が未設定です。");
    process.exit(1);
  }

  const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/ingest-s0`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ events: s0Events }),
  });

  const body = await res.json();
  if (!res.ok) {
    console.error("S0シード失敗:", body);
    process.exit(1);
  }

  console.log(`S0シード完了: ${body.count} 件投入`);
}

main();
