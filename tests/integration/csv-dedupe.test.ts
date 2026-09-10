/**
 * CSV の二重取込を実DBで止める（発注 ①-5）。
 *
 * ## なぜ実DBが要るか
 *
 * 鍵の作り方は**2か所にある。** TypeScript の `csvEventId`（取り込み時）と、
 * 00045 の `csv_event_id`（既存行の組み直し）である。
 * **この2つがずれると、migration の前と後で同じ取引が別の鍵になる。**
 *
 * 単体試験は TypeScript 側しか見ない。SQL 側と噛み合っているかは、
 * **実DBで両方を走らせてはじめて分かる。**
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { csvEventId } from "@/lib/csv/event-id";

const SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const canRun = Boolean(SERVICE_KEY);

if (!canRun) {
  // **静かな skip にしない。** 何が走らなかったかを必ず出す
  process.stderr.write(
    "\n[csv-dedupe.test] SKIP: SUPABASE_SERVICE_ROLE_KEY が未設定のため未実行（ローカル環境）。\n\n",
  );
}

describe.skipIf(!canRun)("CSV の鍵が TypeScript と SQL で一致する", () => {
  let admin: SupabaseClient;
  const companyId = "00000000-0000-0000-0000-0000000c5d01";

  /** SQL 側の鍵を引く。**同じ引数を渡して結果を比べる** */
  async function sqlKey(args: {
    date: string;
    direction: string;
    amount: number;
    description: string;
    balance: number | null;
  }): Promise<string> {
    const { data, error } = await admin.rpc("csv_event_id", {
      p_company: companyId,
      p_date: args.date,
      p_direction: args.direction,
      p_amount: args.amount,
      p_description: args.description,
      p_balance: args.balance,
    });
    if (error) throw new Error(`csv_event_id の呼び出しに失敗: ${error.message}`);
    return data as string;
  }

  beforeAll(() => {
    admin = createClient(SUPABASE_URL, SERVICE_KEY);
  });

  afterAll(async () => {
    if (admin) await admin.from("events").delete().eq("company_id", companyId);
  });

  it("入金の行で、TypeScript と SQL の鍵が一致する", async () => {
    const key = {
      date: "2026-09-01",
      direction: "credit" as const,
      amount: 396000,
      description: "カ）サンプル ショウジ",
      balance: 1234567,
    };
    expect(await sqlKey(key)).toBe(csvEventId({ companyId, ...key }));
  });

  it("**出金列に負の金額が入った CSV でも、前後で同じ鍵になる**（検収の指摘）", async () => {
    // 取り込み側は `Math.abs` で非負に揃える。00045 も `abs(metrics.amount)` で
    // 鍵を作るので、**符号付きのまま入れると migration の前後で鍵がずれる**
    const key = {
      date: "2026-09-02",
      direction: "debit" as const,
      amount: 50000,
      description: "デンキ ダイ",
      balance: null,
    };
    const fromTs = csvEventId({ companyId, ...key });
    expect(await sqlKey(key)).toBe(fromTs);

    // 実際に -50000 で1行入れ、組み直しの対象にしたときも1行に畳まれること
    const rows = [
      {
        event_id: fromTs,
        company_id: companyId,
        occurred_at: "2026-09-02T00:00:00.000Z",
        ingested_at: new Date().toISOString(),
        source: "csv:accounting",
        event_type: "transaction",
        entity_refs: [],
        metrics: { description: "デンキ ダイ", amount: -50000, direction: "debit" },
        sensitivity: "S1",
      },
    ];
    const { error } = await admin.from("events").upsert(rows, { onConflict: "event_id" });
    expect(error, `1行目が入らない: ${error?.message}`).toBeNull();

    // 同じ内容を**別のファイル名のつもりで**もう一度入れても増えない
    const again = await admin.from("events").upsert(rows, { onConflict: "event_id" });
    expect(again.error).toBeNull();

    const { count } = await admin
      .from("events")
      .select("event_id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .eq("source", "csv:accounting");
    expect(count).toBe(1);
  });

  it("摘要の全角・半角の違いを、SQL 側も同一と読む", async () => {
    const base = { date: "2026-09-03", direction: "credit" as const, amount: 1000, balance: null };
    const half = await sqlKey({ ...base, description: "ﾃﾞﾝｷ ﾀﾞｲ" });
    const full = await sqlKey({ ...base, description: "デンキ　ダイ" });
    expect(half).toBe(full);
    expect(half).toBe(csvEventId({ companyId, ...base, description: "デンキ ダイ" }));
  });

  it("**陰性**: 別の取引は SQL 側でも別の鍵になる（潰しすぎない）", async () => {
    const base = {
      date: "2026-09-04",
      direction: "credit" as const,
      amount: 1000,
      description: "A社",
      balance: null,
    };
    const other = await sqlKey({ ...base, description: "B社" });
    expect(other).not.toBe(await sqlKey(base));
  });
});
