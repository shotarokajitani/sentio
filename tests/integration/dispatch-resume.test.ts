/**
 * pending の予約が実 DB で通ることを確かめる（⑥J-4 の欠陥の再発防止）。
 *
 * ## なぜ実 DB が要るか
 *
 * **単体試験は全部緑のまま、本番では1行も書けていなかった。**
 * 2026-09-12 の本番ログにこれが毎朝出ていた。
 *
 *     dispatch: pending の予約に失敗:
 *     there is no unique or exclusion constraint matching the ON CONFLICT
 *     specification (42P10)
 *
 * 原因は 00043 の一意索引が**部分索引**だったこと。PostgREST の
 * `upsert(onConflict: "…")` は列名から制約を推論するので、
 * **`WHERE` 句の付いた索引は候補にならない。**
 *
 * これはモックした依存では絶対に出ない。**onConflict の推論は Postgres の
 * 仕事であり、こちらのコードには現れない。** 実 DB に当てるしかない。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const canRun = Boolean(SERVICE_KEY);

if (!canRun) {
  // **静かな skip にしない。** 何が走らなかったかを必ず出す
  process.stderr.write(
    "\n[dispatch-resume.test] SKIP: SUPABASE_SERVICE_ROLE_KEY が未設定のため未実行（ローカル環境）。\n\n",
  );
}

describe.skipIf(!canRun)("pending の予約と再開（実DB）", () => {
  let admin: SupabaseClient;
  const companyA = "00000000-0000-0000-0000-00000000d101";
  const companyB = "00000000-0000-0000-0000-00000000d102";
  const runKey = "2026-09-13";

  /** `dispatch-runtime.ts` の `reservePending` と**同じ呼び方**をする */
  async function reservePending(companyIds: string[]) {
    return await admin.from("dispatch_runs").upsert(
      companyIds.map((companyId) => ({
        kind: "company",
        dispatch: "daily",
        company_id: companyId,
        outcome: "pending",
        run_key: runKey,
      })),
      { onConflict: "dispatch,run_key,company_id", ignoreDuplicates: true },
    );
  }

  async function rowsOf() {
    const { data, error } = await admin
      .from("dispatch_runs")
      .select("company_id, outcome, finished_at")
      .eq("kind", "company")
      .eq("dispatch", "daily")
      .eq("run_key", runKey);
    if (error) throw new Error(`引けなかった: ${error.message}`);
    return data ?? [];
  }

  beforeAll(() => {
    admin = createClient(SUPABASE_URL, SERVICE_KEY);
  });

  afterAll(async () => {
    if (admin) await admin.from("dispatch_runs").delete().eq("run_key", runKey);
  });

  it("**42501 ではなく 42P10 が出ないこと。** upsert が通る", async () => {
    const { error } = await reservePending([companyA, companyB]);

    expect(error, `予約に失敗した: ${error?.code} ${error?.message}`).toBeNull();
    expect(await rowsOf()).toHaveLength(2);
  });

  it("**陰性**: 2回目の予約で行が増えない（冪等）", async () => {
    await reservePending([companyA, companyB]);
    const { error } = await reservePending([companyA, companyB]);

    expect(error).toBeNull();
    expect(await rowsOf()).toHaveLength(2);
  });

  it("**陰性**: 終わった会社を pending に戻さない", async () => {
    await reservePending([companyA]);
    await admin
      .from("dispatch_runs")
      .update({ outcome: "delivered", finished_at: new Date().toISOString() })
      .eq("kind", "company")
      .eq("dispatch", "daily")
      .eq("run_key", runKey)
      .eq("company_id", companyA);

    await reservePending([companyA]);

    const row = (await rowsOf()).find((r) => r.company_id === companyA);
    expect(row?.outcome).toBe("delivered");
    expect(row?.finished_at).not.toBeNull();
  });

  it("2回目の実行は「全社 finished なので0社」で終わる", async () => {
    await reservePending([companyA, companyB]);
    const now = new Date().toISOString();
    for (const id of [companyA, companyB]) {
      await admin
        .from("dispatch_runs")
        .update({ outcome: "delivered", finished_at: now })
        .eq("kind", "company")
        .eq("dispatch", "daily")
        .eq("run_key", runKey)
        .eq("company_id", id);
    }

    const rows = await rowsOf();
    const unfinished = rows.filter((r) => r.finished_at === null);

    // **行はある（total > 0）が、未完了は0件。** この2つを区別できないと、
    // 再開の cron が毎回全社を最初からやり直す
    expect(rows.length).toBeGreaterThan(0);
    expect(unfinished).toHaveLength(0);
  });

  it("**陰性**: run_key が NULL の行は何行でも入る（既存行を残すため）", async () => {
    // 本番の37行は run_key が NULL のまま残っている。
    // `NULLS NOT DISTINCT` にすると、この既存行が衝突して migration が落ちる
    const nullRow = {
      kind: "company",
      dispatch: "daily",
      company_id: companyA,
      outcome: "delivered",
    };
    const first = await admin.from("dispatch_runs").insert(nullRow);
    const second = await admin.from("dispatch_runs").insert(nullRow);

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();

    await admin.from("dispatch_runs").delete().eq("company_id", companyA).is("run_key", null);
  });
});
