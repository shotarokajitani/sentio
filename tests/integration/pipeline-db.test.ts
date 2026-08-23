import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveRlsRunMode } from "../helpers/rls-run-mode";

/**
 * S-3: パイプラインの一気通貫を **実DBと実 Edge Function** で通す。
 *
 * `tests/unit/pipeline-inmemory.test.ts` が「実DBに当たる版はここ」と書いていたのに、
 * このファイルは存在していなかった（2026-08-24 に着手時点で確認）。
 * インメモリ版は `src/` の純関数に手作りのオブジェクトを渡すだけなので、
 * **Function 同士の配線が壊れていても緑のままになる。**
 *
 * 検証するのは契約の S-3-1 / S-3-2 / S-3-3。
 * S-3-5（本番データでの完走）は検収者関門なのでここでは扱わない。
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
      "一気通貫が実行されないまま緑になるのを防ぐため失敗させる（契約 S-5-5）",
  );
}

/** このテスト専用の会社。edge-functions.test.ts の 5e1 / 5e2 とは分ける */
const COMPANY = "00000000-0000-0000-0000-0000000005e3";

/**
 * 宛先。**この経路では送信しない**（intent: "defer"）ので実際には使われないが、
 * 万一送信経路に入った場合に外へ出ないよう、予約された無効ドメインを使う（RFC 6761）。
 */
const RECIPIENT = "s3-pipeline@example.invalid";

interface Invoked {
  status: number;
  body: Record<string, unknown>;
  raw: string;
}

async function invoke(
  name: string,
  payload: Record<string, unknown>,
  key: string | undefined = SERVICE_KEY,
): Promise<Invoked> {
  let res: Response;
  try {
    res = await fetch(`${FUNCTIONS_URL}/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // 到達できないことを skip に丸めない
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
    // JSON でない応答も raw で見えるようにする
  }
  return { status: res.status, body, raw };
}

/**
 * パルスの対象期間は JST の1日。**固定日を書かない**（実行日によって
 * 90日窓や「未来日」の扱いが変わり、`ingest-calendar` と同じ腐り方をするため）。
 */
const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
const PERIOD = jstNow.toISOString().slice(0, 10);
const windowStart = new Date(`${PERIOD}T00:00:00+09:00`);
/** JST のその日の中に必ず収まり、かつ now を追い越さない時刻 */
const at = (seconds: number) => new Date(windowStart.getTime() + seconds * 1000).toISOString();

/**
 * 仕込むイベント。**immediate と非 immediate の両方を出す**のが要点である。
 *
 * - `monitor` の `status: "down"` → scan が `immediate` を出す
 *   → run-sense の事実アラート高速路が findings を INSERT する（S-3-2・LLM を通らない）
 * - `external` の S0 → scan が `monthly` を出す
 *   → run-sense が Investigator を呼ぶ（CI ではスタブ。配線が通ることの確認）
 *
 * 非 immediate を外して immediate だけにすると Investigator の配線を一度も通らないので、
 * 「一気通貫」を名乗れなくなる。
 */
const SEEDED = [
  {
    event_id: "it-s3-tx-1",
    event_type: "transaction",
    source: "csv:accounting",
    sensitivity: "S1",
    metrics: { revenue: 120000 },
    occurred_at: at(1),
  },
  {
    event_id: "it-s3-tx-2",
    event_type: "transaction",
    source: "csv:accounting",
    sensitivity: "S1",
    metrics: { revenue: 118000 },
    occurred_at: at(2),
  },
  {
    event_id: "it-s3-monitor-down",
    event_type: "monitor",
    source: "monitor:uptime",
    sensitivity: "S1",
    metrics: { status: "down", url: "https://example.invalid/health" },
    occurred_at: at(3),
  },
  {
    event_id: "it-s3-external",
    event_type: "external",
    source: "external:careers",
    sensitivity: "S0",
    metrics: { relevance: "競合の採用ページ新設" },
    occurred_at: at(4),
  },
];

describe.skipIf(mode === "skip")("パイプライン一気通貫 (S-3)", () => {
  let admin: SupabaseClient;
  /** 各段の実測を1箇所に集め、失敗時にどこで落ちたかが読めるようにする */
  const stages: Record<string, number> = {};

  beforeAll(async () => {
    admin = createClient(SUPABASE_URL, SERVICE_KEY!);
    await cleanup();

    const rows = SEEDED.map((e) => ({
      ...e,
      company_id: COMPANY,
      ingested_at: new Date().toISOString(),
      entity_refs: [],
    }));

    const { error } = await admin.from("events").insert(rows);
    if (error) throw new Error(`前提データの投入に失敗: ${error.message}`);
  });

  afterAll(async () => {
    await cleanup();
  });

  async function cleanup() {
    // per_worker でワーカーが使い回されるため、状態はテスト側で明示的に落とす
    // （契約 PR #37 の副作用。`docs/reports/2026-08-21_CI_503フレークの実測.md`）
    await admin.from("delivery_log").delete().eq("company_id", COMPANY);
    await admin.from("findings").delete().eq("company_id", COMPANY);
    await admin.from("company_summary").delete().eq("company_id", COMPANY);
    await admin.from("narratives").delete().eq("company_id", COMPANY);
    await admin.from("baselines").delete().eq("company_id", COMPANY);
    await admin.from("events").delete().eq("company_id", COMPANY);
  }

  it("S-3-1: state-baselines → state-summary → scan → run-sense → deliver-pulse が全て 2xx で完走する", async () => {
    for (const name of ["state-baselines", "state-summary", "scan"]) {
      const r = await invoke(name, { company_id: COMPANY });
      stages[name] = r.status;
      expect(r.status, `${name} の応答: ${r.raw}`).toBeLessThan(300);
      expect(r.status, `${name} の応答: ${r.raw}`).toBeGreaterThanOrEqual(200);
    }

    // run-sense は investigate を呼ぶ。CI では INVESTIGATE_FUNCTION=investigate-stub。
    // 未設定なら本物を呼びに行くので、鍵の無い環境ではここが落ちて顕在化する
    const sense = await invoke("run-sense", { company_id: COMPANY });
    stages["run-sense"] = sense.status;
    expect(sense.status, `run-sense の応答: ${sense.raw}`).toBeLessThan(300);

    // deliver-pulse は intent: "defer" で呼ぶ。**送信経路には入らない。**
    // Sentio は何も勝手に送らない（CLAUDE.md 絶対規則）
    const pulse = await invoke("deliver-pulse", {
      company_id: COMPANY,
      email: RECIPIENT,
      target_date: PERIOD,
      intent: "defer",
    });
    stages["deliver-pulse"] = pulse.status;
    expect(pulse.status, `deliver-pulse の応答: ${pulse.raw}`).toBeLessThan(300);
    expect(pulse.body.email_sent, `deliver-pulse の応答: ${pulse.raw}`).toBe(false);

    // 5段すべてが 2xx だったことを1つの実測値として残す
    expect(stages).toMatchObject({
      "state-baselines": expect.any(Number),
      "state-summary": expect.any(Number),
      scan: expect.any(Number),
      "run-sense": expect.any(Number),
      "deliver-pulse": expect.any(Number),
    });
  });

  it("S-3-2: findings に1件以上 INSERT される", async () => {
    const { data, error } = await admin
      .from("findings")
      .select("id, status, urgency, what, eval_log")
      .eq("company_id", COMPANY);

    expect(error).toBeNull();
    expect(
      data ?? [],
      "findings が0件。scan の immediate 判定か run-sense の挿入を疑う",
    ).not.toHaveLength(0);

    // 事実アラート高速路（LLM を通らない経路）で入っていることを固定する。
    // ここが Investigator 由来にすり替わると、鍵の無い CI では常に0件に戻る
    const fast = (data ?? []).filter(
      (f) => (f.eval_log as { source?: string } | null)?.source === "fast_path",
    );
    expect(fast, "fast_path 由来の finding が無い").not.toHaveLength(0);
    expect(fast[0].urgency).toBe("immediate");
    expect(fast[0].status).toBe("open");
  });

  it("S-3-3: deliver-pulse の本文がその回の実データを反映する", async () => {
    const { data: events } = await admin
      .from("events")
      .select("event_id")
      .eq("company_id", COMPANY);
    const { data: findings } = await admin
      .from("findings")
      .select("id")
      .eq("company_id", COMPANY)
      .eq("status", "open");

    const r = await invoke("deliver-pulse", {
      company_id: COMPANY,
      email: RECIPIENT,
      target_date: PERIOD,
      intent: "defer",
    });

    const lines = r.body.pulse as string[];
    expect(lines, `deliver-pulse の応答: ${r.raw}`).toBeDefined();

    // 件数が実データ由来であること。定型文だけを返していたらここで落ちる
    expect(lines[0]).toContain(String((events ?? []).length));
    expect(lines[0]).toContain(PERIOD);
    // 種別も実データ由来（仕込んだ monitor / external / transaction が現れる）
    expect(lines[1]).toContain("monitor");
    expect(lines[1]).toContain("transaction");
    // 未対応 Finding の件数が反映される
    expect(lines.join("\n")).toContain(`${(findings ?? []).length}件のFinding`);
  });

  it("S-3-3: delivery_log の status が実際の結果（未送信）を反映する", async () => {
    const { data } = await admin
      .from("delivery_log")
      .select("status, delivery_type")
      .eq("company_id", COMPANY);

    expect(data ?? []).not.toHaveLength(0);
    // 送っていないので sent にはならない。ここが sent になったら実送信している
    for (const row of data ?? []) {
      expect(row.delivery_type).toBe("pulse");
      expect(row.status).toBe("deferred");
    }
  });

  // 陰性コントロール。intent は internal からしか受けない（契約 S-3-1 の判断条件）。
  // anon キーはそもそも呼び出し元判定で弾かれる（S-4-2）ことをここでも固定する
  it("陰性コントロール: anon キーからは intent を渡す以前に 401 で弾かれる", async () => {
    const r = await invoke(
      "deliver-pulse",
      { company_id: COMPANY, email: RECIPIENT, target_date: PERIOD, intent: "defer" },
      ANON_KEY,
    );
    expect(r.status, `応答: ${r.raw}`).toBe(401);
  });
});
