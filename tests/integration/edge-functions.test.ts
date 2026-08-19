import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveRlsRunMode } from "../helpers/rls-run-mode";

/**
 * S-5-2: Edge Function を **実際に起動して実DBに当てる**。
 *
 * これまで CI にあったのは `src/` の純関数を叩くテストだけで、Edge Function が
 * 実スキーマに対して動くかを見る経路が1つも無かった。列が存在しなくても
 * `error` が握りつぶされて 200 が返るため、壊れたまま緑が続いていた。
 *
 * 環境変数が無いときに **skip で緑にしない**（S-5-5）。CI では fail させる。
 */

const SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

const mode = resolveRlsRunMode({
  ci: process.env.CI === "true",
  anonKey: ANON_KEY,
  serviceKey: SERVICE_KEY,
});

if (mode === "fail") {
  throw new Error(
    "CI で SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定。" +
      "Edge Function の実DB検証が実行されないまま緑になるのを防ぐため失敗させる（契約 S-5-5）",
  );
}

/** データが揃っている会社 */
const COMPANY_WITH_DATA = "00000000-0000-0000-0000-0000000005e1";
/** データが1件も無い会社（0件とエラーの区別を見るため） */
const COMPANY_EMPTY = "00000000-0000-0000-0000-0000000005e2";

interface Invoked {
  status: number;
  body: Record<string, unknown>;
  raw: string;
}

async function invoke(name: string, payload: Record<string, unknown>): Promise<Invoked> {
  let res: Response;
  try {
    res = await fetch(`${FUNCTIONS_URL}/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // 到達できないことを skip に丸めない。ハーネスが無いのに緑を返すのが今回の学び
    throw new Error(
      `${name} に到達できない（${FUNCTIONS_URL}）: ${(e as Error).message}。` +
        "Edge Runtime が起動しているか確認すること",
    );
  }

  const raw = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // JSON でない応答も、そのまま raw で見えるようにする
  }
  return { status: res.status, body, raw };
}

function sectionContent(body: Record<string, unknown>, type: string): string | undefined {
  const packet = body.packet as { sections?: { type: string; content: string }[] } | undefined;
  return packet?.sections?.find((s) => s.type === type)?.content;
}

describe.skipIf(mode === "skip")("Edge Function を実DBに当てる (S-5-2)", () => {
  let admin: SupabaseClient;

  beforeAll(async () => {
    admin = createClient(SUPABASE_URL, SERVICE_KEY!);

    await cleanup();

    // ベースラインが確立する分（MIN_OBS = 5）の取引イベントを積む
    const events = Array.from({ length: 12 }, (_, i) => ({
      event_id: `it-edge-${i}`,
      company_id: COMPANY_WITH_DATA,
      occurred_at: new Date(Date.UTC(2026, 6, i + 1)).toISOString(),
      ingested_at: new Date().toISOString(),
      source: "csv:accounting",
      event_type: "transaction",
      entity_refs: [],
      metrics: { revenue: 100000 + i * 1000 },
      sensitivity: "S1",
    }));

    const { error } = await admin.from("events").insert(events);
    if (error) throw new Error(`前提データの投入に失敗: ${error.message}`);
  });

  afterAll(async () => {
    await cleanup();
  });

  async function cleanup() {
    for (const company of [COMPANY_WITH_DATA, COMPANY_EMPTY]) {
      await admin.from("events").delete().eq("company_id", company);
      await admin.from("baselines").delete().eq("company_id", company);
      await admin.from("narratives").delete().eq("company_id", company);
      await admin.from("company_summary").delete().eq("company_id", company);
      await admin.from("findings").delete().eq("company_id", company);
    }
  }

  it("state-baselines が実スキーマに対して成功し、stats が実際に埋まる (S-1-1)", async () => {
    const r = await invoke("state-baselines", { company_id: COMPANY_WITH_DATA });
    expect(r.status, `応答: ${r.raw}`).toBe(200);

    const { data, error } = await admin
      .from("baselines")
      .select("metric_key, granularity, stats, is_established, min_obs")
      .eq("company_id", COMPANY_WITH_DATA);

    expect(error).toBeNull();
    expect(data ?? []).not.toHaveLength(0);

    const revenue = (data ?? []).find((b) => b.metric_key === "revenue");
    expect(revenue, "revenue のベースライン行が無い").toBeDefined();
    expect(revenue!.granularity, "granularity は NOT NULL なので明示が要る").toBeTruthy();
    expect(revenue!.is_established).toBe(true);
    expect(revenue!.stats).toMatchObject({ median: expect.any(Number), iqr: expect.any(Number) });
  });

  it("state-baselines を2回呼んでも一意制約で1行に収束する (S-1-1)", async () => {
    await invoke("state-baselines", { company_id: COMPANY_WITH_DATA });
    await invoke("state-baselines", { company_id: COMPANY_WITH_DATA });

    const { data } = await admin
      .from("baselines")
      .select("id")
      .eq("company_id", COMPANY_WITH_DATA)
      .eq("metric_key", "revenue");

    expect(data ?? []).toHaveLength(1);
  });

  it("state-narratives が実スキーマ（category/topic/source_event_ids）で成功する (S-1-3)", async () => {
    const r = await invoke("state-narratives", {
      company_id: COMPANY_WITH_DATA,
      category: "external",
      topic: "主要顧客",
      content: "A社への依存が高い",
      source_event_ids: ["it-edge-0"],
    });
    expect(r.status, `応答: ${r.raw}`).toBe(200);

    const { data } = await admin
      .from("narratives")
      .select("category, topic, content, confidence, source_event_ids, last_confirmed_at")
      .eq("company_id", COMPANY_WITH_DATA);

    expect(data ?? []).toHaveLength(1);
    expect(data![0].category).toBe("external");
    expect(data![0].topic).toBe("主要顧客");
    expect(data![0].source_event_ids).toContain("it-edge-0");
  });

  it("state-summary が company_summary を実際に書く", async () => {
    const r = await invoke("state-summary", { company_id: COMPANY_WITH_DATA });
    expect(r.status, `応答: ${r.raw}`).toBe(200);

    const { data } = await admin
      .from("company_summary")
      .select("content, token_count")
      .eq("company_id", COMPANY_WITH_DATA)
      .single();

    expect(data?.content).toBeTruthy();
  });

  it("state-memory-packet の baselines / narratives が実際に埋まる (S-1-5 / P-4 の解消)", async () => {
    await invoke("state-baselines", { company_id: COMPANY_WITH_DATA });
    await invoke("state-summary", { company_id: COMPANY_WITH_DATA });

    const r = await invoke("state-memory-packet", { company_id: COMPANY_WITH_DATA });
    expect(r.status, `応答: ${r.raw}`).toBe(200);

    // 「(no baselines)」を返して 200 で終わるのが今回潰す対象そのもの
    expect(sectionContent(r.body, "baselines")).not.toBe("(no baselines)");
    expect(sectionContent(r.body, "narratives")).not.toBe("(no narratives)");
    expect(sectionContent(r.body, "baselines")).toContain("revenue");
  });

  it("state-memory-packet が予定タイトルなどの本文を載せない", async () => {
    const r = await invoke("state-memory-packet", { company_id: COMPANY_WITH_DATA });
    const recent = sectionContent(r.body, "recent_events") ?? "";

    // metrics を丸ごと載せると、編成器を共通経路にしている3機能すべてに本文が流れ込む
    expect(recent).not.toContain("revenue");
    expect(recent).toContain("transaction");
  });

  it("scan が 200 で完走する", async () => {
    const r = await invoke("scan", { company_id: COMPANY_WITH_DATA });
    expect(r.status, `応答: ${r.raw}`).toBe(200);
    expect(r.body.status).toBe("ok");
  });

  it("run-sense が 200 で完走する", async () => {
    const r = await invoke("run-sense", { company_id: COMPANY_WITH_DATA });
    expect(r.status, `応答: ${r.raw}`).toBe(200);
  });

  it("データが無い会社では 0件が正常系として返る（エラーと区別できる） (S-2-3)", async () => {
    const r = await invoke("scan", { company_id: COMPANY_EMPTY });

    expect(r.status, `応答: ${r.raw}`).toBe(200);
    expect(r.body.status).toBe("ok");
    expect(r.body.total_candidates).toBe(0);
    expect(r.body.error).toBeUndefined();
  });

  it("存在しない列を読ませると 5xx になる（握りつぶして 200 を返さない） (S-2-2)", async () => {
    // 実在しない company_id 形式を渡して DB エラーを起こす。
    // UUID として不正なので PostgREST が 22P02 を返す経路になる
    const r = await invoke("state-baselines", { company_id: "not-a-uuid" });

    expect(r.status, `応答: ${r.raw}`).toBeGreaterThanOrEqual(500);
    expect(r.body.error).toBeTruthy();
  });
});
