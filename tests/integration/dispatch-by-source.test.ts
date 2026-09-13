/**
 * Google 連携が切れた会社でも、CSV 由来の処理が走ることを実物の経路で確かめる
 * （PS-9c の改訂・2026-09-13）。
 *
 * ## なぜ実 DB が要るか
 *
 * 源の鮮度は `last_ingested_by_source()`（00047）が DB 側で集計する。
 * **関数の権限・集計・`buildDeps` の組み立てが噛み合って初めて、源ごとの判定が効く。**
 * 単体試験では `sources` を手で渡すので、この噛み合わせは見えない。
 *
 * 固定するのは3つ（発注の陰性コントロール (a)(b)(e)）。
 *
 *   (a) Google が revoked の会社で、予定の平常値の更新が呼ばれない
 *   (b) 同じ会社で、入出金の平常値の更新と配信は呼ばれる
 *   (e) 源が0の会社は skipped のまま
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { assertNoLiveMailConfig } from "../fixtures/recipients";

const SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const canRun = Boolean(SERVICE_KEY);

if (!canRun) {
  process.stderr.write(
    "\n[dispatch-by-source.test] SKIP: SUPABASE_SERVICE_ROLE_KEY が未設定のため未実行（ローカル環境）。\n\n",
  );
}

function installDenoShim() {
  const g = globalThis as unknown as { Deno?: { env: { get(k: string): string | undefined } } };
  if (!g.Deno) g.Deno = { env: { get: (k: string) => process.env[k] } };
}

describe.skipIf(!canRun)("源ごとの判定を実物の経路で通す", () => {
  let admin: SupabaseClient;
  let revokedCompany: string;
  let emptyCompany: string;
  const createdUsers: string[] = [];

  /** 呼ばれた関数と本文を控える。**メールは送らない** */
  const calls: Array<{ fn: string; body: Record<string, unknown> }> = [];

  async function makeUser(label: string): Promise<string> {
    const { data, error } = await admin.auth.admin.createUser({
      email: `source-${label}-${Date.now()}@example.invalid`,
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(`createUser(${label}) 失敗: ${error?.message}`);
    createdUsers.push(data.user.id);
    return data.user.id;
  }

  async function runOnce(targetIds: string[]) {
    const { buildDeps } = await import("@edge/_shared/dispatch-runtime");
    const { runDispatch } = await import("@edge/_shared/dispatch");

    const real = buildDeps("daily");
    // **対象の一覧だけを絞る。** 源の状態は実物の `listTargets` が組んだものを使う
    const all = await real.listTargets();
    const targets = all.filter((t) => targetIds.includes(t.companyId));

    return await runDispatch(
      "daily",
      { kind: "internal" },
      {
        ...real,
        listTargets: async () => targets,
        invoke: async (fn: string, body: Record<string, unknown>) => {
          calls.push({ fn, body });
          return { ok: true, status: 200 };
        },
        countBillingUnresolved: async () => ({ unresolved: 0, resolved: 0, stale: 0 }),
        notifyOpsBillingUnresolved: async () => ({ ok: true as const }),
        sweepStaleSending: undefined,
        reservePending: undefined,
        finishCompany: undefined,
        listRunState: undefined,
      },
    );
  }

  beforeAll(async () => {
    assertNoLiveMailConfig();
    installDenoShim();
    admin = createClient(SUPABASE_URL, SERVICE_KEY);

    revokedCompany = await makeUser("revoked");
    emptyCompany = await makeUser("empty");

    // Google は切れている
    const conn = await admin.from("connections").insert({
      company_id: revokedCompany,
      provider: "google_calendar",
      status: "revoked",
    });
    if (conn.error) throw new Error(`connections の投入に失敗: ${conn.error.message}`);

    // CSV は3日前に取り込んでいる（生きている源）
    const ingested = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const rows = [0, 1, 2, 3, 4, 5].map((i) => ({
      event_id: `source-test-${revokedCompany}-${i}`,
      company_id: revokedCompany,
      occurred_at: new Date(Date.now() - (i + 4) * 86_400_000).toISOString(),
      ingested_at: ingested,
      source: "csv:accounting",
      event_type: "transaction",
      entity_refs: [],
      metrics: { amount: 100000 + i, direction: "credit", description: "取引先A" },
      sensitivity: "S1",
    }));
    const ev = await admin.from("events").insert(rows);
    if (ev.error) throw new Error(`events の投入に失敗: ${ev.error.message}`);
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.from("events").delete().eq("company_id", revokedCompany);
    await admin.from("connections").delete().eq("company_id", revokedCompany);
    for (const id of createdUsers) await admin.auth.admin.deleteUser(id);
  });

  it("実物の listTargets が、revoked の会社に源の状態を載せる", async () => {
    const { buildDeps } = await import("@edge/_shared/dispatch-runtime");
    const all = await buildDeps("daily").listTargets();
    const t = all.find((x) => x.companyId === revokedCompany);

    expect(t?.sources, "sources が付いていない（00047 の関数が引けていない）").toBeDefined();
    const byProvider = Object.fromEntries((t?.sources ?? []).map((s) => [s.provider, s.status]));
    expect(byProvider).toEqual({ google_calendar: "revoked", "csv:accounting": "live" });
  });

  it("(b) revoked の会社でも、入出金の平常値の更新と配信が呼ばれる", async () => {
    calls.length = 0;
    await runOnce([revokedCompany]);

    const fns = calls.map((c) => c.fn);
    expect(fns).toContain("state-baselines");
    expect(fns).toContain("deliver-pulse");
    // **run-sense は呼ばない**（(f)。止まっている源がある会社は LLM へ入れない）
    expect(fns).not.toContain("run-sense");

    const state = calls.find((c) => c.fn === "state-baselines");
    expect(state?.body.live_sources).toEqual(["csv:accounting"]);
  });

  it("(a) **陰性**: 予定の平常値は更新しないよう、カレンダーを生きている源に含めない", async () => {
    calls.length = 0;
    await runOnce([revokedCompany]);

    for (const c of calls) {
      const live = c.body.live_sources as string[] | undefined;
      expect(live, `${c.fn} に源の情報が渡っていない`).toBeDefined();
      expect(live, c.fn).not.toContain("google_calendar");
    }
    // 再連携のお願いを**別のメールで**送らない（本文の1行にする）
    expect(calls.some((c) => c.body.kind === "reconnect")).toBe(false);
  });

  it("止まっている源の最後の取り込み時刻を、配信へ渡す（本文の1行に使う）", async () => {
    calls.length = 0;
    await runOnce([revokedCompany]);

    const pulse = calls.find((c) => c.fn === "deliver-pulse");
    const stopped = pulse?.body.stopped_sources as Array<{ provider: string; status: string }>;
    expect(stopped?.map((s) => [s.provider, s.status])).toEqual([["google_calendar", "revoked"]]);
  });

  it("(f) **陰性**: 止まっている源がある会社では run-sense を呼ばない（LLM へ入れない）", async () => {
    calls.length = 0;
    const result = await runOnce([revokedCompany]);

    // `run-sense` の先に LLM がある。**止まっている源の値を材料に混ぜない**
    expect(calls.map((c) => c.fn)).not.toContain("run-sense");
    const body = result.body as { sense_skipped_stopped_source: number };
    expect(body.sense_skipped_stopped_source).toBe(1);
  });

  it("(g) **陰性**: 止まっている源のイベントを材料に入れない（実DBの読み込み）", async () => {
    // Google 由来のイベントを1件入れる。止まっている源なので読まれてはいけない
    const googleRow = {
      event_id: `source-test-${revokedCompany}-google`,
      company_id: revokedCompany,
      occurred_at: new Date(Date.now() - 6 * 86_400_000).toISOString(),
      ingested_at: new Date(Date.now() - 5 * 86_400_000).toISOString(),
      source: "google_calendar",
      event_type: "schedule",
      entity_refs: [],
      metrics: { title: "週次経営会議", attendees: [] },
      sensitivity: "S1",
    };
    const ins = await admin.from("events").insert(googleRow);
    expect(ins.error).toBeNull();

    const { loadPacketInput } = await import("@edge/_shared/state-packet-source");
    const withAll = await loadPacketInput(admin, revokedCompany, new Date());
    const withoutStopped = await loadPacketInput(admin, revokedCompany, new Date(), [
      "google_calendar",
    ]);

    // 除外しなければ読まれる（**試験が効いていることの確認**）
    expect(withAll.events.some((e) => e.source === "google_calendar")).toBe(true);
    // 除外すると1件も入らない
    expect(withoutStopped.events.some((e) => e.source === "google_calendar")).toBe(false);
    // 生きている源は残る
    expect(withoutStopped.events.some((e) => e.source === "csv:accounting")).toBe(true);

    await admin.from("events").delete().eq("event_id", googleRow.event_id);
  });

  it("(h) 止まっている源の1行が、本文の材料として渡る", async () => {
    calls.length = 0;
    await runOnce([revokedCompany]);

    const { stoppedLine } = await import("@edge/_shared/source-state");
    const pulse = calls.find((c) => c.fn === "deliver-pulse");
    const stopped = (pulse?.body.stopped_sources ?? []) as Array<{
      provider: "google_calendar";
      status: "revoked";
      last_ingested_at: string | null;
    }>;
    const lines = stopped.map((st) =>
      stoppedLine({ provider: st.provider, status: st.status, lastIngestedAt: st.last_ingested_at }),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^カレンダーは .*取れていません（再連携はこちら）$/);
  });

  it("(e) **陰性**: 源も連携も無い会社は skipped のまま（何も呼ばない）", async () => {
    calls.length = 0;
    const result = await runOnce([emptyCompany]);

    expect(calls).toEqual([]);
    expect((result.body as { skipped_no_connection: number }).skipped_no_connection).toBe(1);
  });
});
