/**
 * 再開が実物の経路で動くことを確かめる（⑥J-4 の欠陥の再発防止）。
 *
 * ## なぜ実 DB と実物の deps が要るか
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
 * これはモックした依存では絶対に出ない。**`onConflict` の推論は Postgres の
 * 仕事であり、こちらのコードには現れない。**
 *
 * さらに「再開の2回目が0社で終わる」も、`listRunState` の実物を通さないと
 * 意味を持たない。**予約が書けていなければ、未完了は常に0件**になり、
 * モックでは「0社で終わった」ように見えてしまうからである。
 *
 * ## Deno の shim について
 *
 * `buildDeps` は `Deno.env.get` で接続先を読む。Node の vitest には `Deno` が
 * 無いので、**環境変数を読ませるためだけの薄い shim**を先頭で置く。
 * 実装は1行も変えていない。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { assertNoLiveMailConfig } from "../fixtures/recipients";

const SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const canRun = Boolean(SERVICE_KEY);

if (!canRun) {
  // **静かな skip にしない。** 何が走らなかったかを必ず出す
  process.stderr.write(
    "\n[dispatch-resume.test] SKIP: SUPABASE_SERVICE_ROLE_KEY が未設定のため未実行（ローカル環境）。\n\n",
  );
}

/** `Deno.env.get` だけを埋める。**実装を変えないための細工である** */
function installDenoShim() {
  const g = globalThis as unknown as { Deno?: { env: { get(k: string): string | undefined } } };
  if (!g.Deno) g.Deno = { env: { get: (k: string) => process.env[k] } };
}

describe.skipIf(!canRun)("再開の2回目は実物の listRunState で0社になる", () => {
  let admin: SupabaseClient;
  const companyA = "00000000-0000-0000-0000-00000000d101";
  const companyB = "00000000-0000-0000-0000-00000000d102";

  /** 実行の鍵。`runKeyOf` が JST の日付を返すので、それに合わせる */
  let runKey: string;

  /** 会社の処理。**メールは送らない。呼ばれた会社を数えるだけ** */
  const invoked: string[] = [];

  async function rowsOf() {
    const { data, error } = await admin
      .from("dispatch_runs")
      .select("company_id, outcome, finished_at, started_at")
      .eq("kind", "company")
      .eq("dispatch", "daily")
      .eq("run_key", runKey);
    if (error) throw new Error(`引けなかった: ${error.message}`);
    return data ?? [];
  }

  /** 実物の deps を取り、対象と呼び出しだけを差し替える */
  async function runOnce() {
    const { buildDeps } = await import("@edge/_shared/dispatch-runtime");
    const { runDispatch } = await import("@edge/_shared/dispatch");

    const real = buildDeps("daily");
    const targets = [companyA, companyB].map((companyId) => ({
      companyId,
      email: "pulse@example.invalid",
      connectionState: "active" as const,
      lastReconnectNoticeAt: null,
      detectedAt: null,
      subscriptionStatus: "active",
    }));

    return await runDispatch(
      "daily",
      { kind: "internal" },
      {
        ...real,
        listTargets: async () => targets,
        // **メールを送らない。** 呼ばれた会社を数えるだけ
        invoke: async (_fn: string, body: Record<string, unknown>) => {
          invoked.push(String(body.company_id));
          return { ok: true, status: 200 };
        },
        countBillingUnresolved: async () => null,
        notifyOpsBillingUnresolved: async () => ({ ok: true as const }),
        // 掃除はこの試験の対象ではない
        sweepStaleSending: undefined,
      },
    );
  }

  beforeAll(async () => {
    // **本物の送信設定が載っていたら止める**（S-2-10）
    assertNoLiveMailConfig();
    installDenoShim();
    admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const { runKeyOf } = await import("@edge/_shared/dispatch-resume");
    runKey = runKeyOf({ kind: "daily", now: new Date() });

    await admin.from("dispatch_runs").delete().eq("run_key", runKey);
  });

  afterAll(async () => {
    if (admin) await admin.from("dispatch_runs").delete().eq("run_key", runKey);
    vi.restoreAllMocks();
  });

  it("1回目は2社を処理し、その run_key の行が2行できて finished_at が入る", async () => {
    invoked.length = 0;
    const result = await runOnce();

    expect(result.status).toBe(200);
    expect(invoked.filter((id) => id === companyA)).not.toHaveLength(0);
    expect(new Set(invoked)).toEqual(new Set([companyA, companyB]));

    const rows = await rowsOf();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.finished_at, `${r.company_id} が終わっていない`).not.toBeNull();
    }
  });

  it("**陰性**: 2回目は0社。行も増えない（再開の cron が最初からやり直さない）", async () => {
    invoked.length = 0;
    const result = await runOnce();

    // **ここが本体。** 予約が書けていないと未完了が常に0件になり、
    // 「初回」と判定されて全社をやり直していた
    expect(invoked).toEqual([]);
    expect((result.body as { resumed?: boolean }).resumed).toBe(true);
    expect(await rowsOf()).toHaveLength(2);
  });

  it("**陰性**: 未完了に戻した1社だけを拾う（全社をやり直さない）", async () => {
    await admin
      .from("dispatch_runs")
      .update({ outcome: "pending", finished_at: null })
      .eq("kind", "company")
      .eq("dispatch", "daily")
      .eq("run_key", runKey)
      .eq("company_id", companyA);

    invoked.length = 0;
    await runOnce();

    expect(
      invoked.every((id) => id === companyA),
      `拾った会社: ${invoked.join(",")}`,
    ).toBe(true);
    expect(invoked.length).toBeGreaterThan(0);
    expect(await rowsOf()).toHaveLength(2);
  });

  it("**陰性**: run_key が NULL の行は何行でも入る（既存行を残すため）", async () => {
    // 本番の37行は `run_key` が NULL のまま残っている。
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
