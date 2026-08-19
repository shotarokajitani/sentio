import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveRlsRunMode } from "../helpers/rls-run-mode";
import { assertNoLiveMailConfig, TEST_RECIPIENT } from "../fixtures/recipients";
import { asDeliveryDb, deliverOnce } from "@edge/_shared/delivery";

/**
 * `00024` と契約 S-2-6 〜 S-2-8 を**実DB・実Function**に当てる。
 *
 * ユニットテスト（`tests/unit/edge-delivery.test.ts`）は順序と状態遷移を固定するが、
 * **一意索引が実際に効くか**と**鍵が無いときに本当に送らないか**は実物でしか分からない。
 * 「ローカルのテストは緑だが本番の実物は違った」がこのスライスを生んだ学びそのもの。
 */

// 送信事故の防止（契約 S-2-10）。**deliver 系に触るテストの先頭で必ず確かめる。**
// 設定が載っていたら skip ではなく throw する。静かにやめると「検証した」と誤読される
assertNoLiveMailConfig();

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
      "配信の冪等性が未検証のまま緑になるのを防ぐため失敗させる（契約 S-5-5）",
  );
}

const COMPANY = "00000000-0000-0000-0000-0000000005d1";

async function invoke(name: string, payload: Record<string, unknown>, token?: string | null) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const raw = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // JSON でない応答も raw で見えるようにする
  }
  return { status: res.status, body, raw };
}

describe.skipIf(mode === "skip")("配信の冪等性を実DBに当てる (00024 / S-2-7)", () => {
  let admin: SupabaseClient;

  beforeAll(async () => {
    admin = createClient(SUPABASE_URL, SERVICE_KEY!);
    await admin.from("delivery_log").delete().eq("company_id", COMPANY);
  });

  afterAll(async () => {
    await admin.from("delivery_log").delete().eq("company_id", COMPANY);
  });

  function row(overrides: Record<string, unknown> = {}) {
    return {
      id: crypto.randomUUID(),
      company_id: COMPANY,
      channel: "email",
      delivery_type: "pulse",
      content: {},
      status: "sending",
      attempts: 1,
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  it("同じ idempotency_key の2行目は一意制約で拒否される（23505）", async () => {
    const key = `pulse:${COMPANY}:2026-08-19`;

    const first = await admin.from("delivery_log").insert(row({ idempotency_key: key }));
    expect(first.error, `1行目が入らない: ${first.error?.message}`).toBeNull();

    const second = await admin.from("delivery_log").insert(row({ idempotency_key: key }));
    expect(second.error?.code, `2行目が通ってしまった（一意索引が無い）`).toBe("23505");
  });

  it("idempotency_key が NULL の行は何行でも共存する（既存ログを壊さない）", async () => {
    const a = await admin.from("delivery_log").insert(row({ idempotency_key: null }));
    const b = await admin.from("delivery_log").insert(row({ idempotency_key: null }));
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
  });

  it("attempts の既定値は 0", async () => {
    const id = crypto.randomUUID();
    const base = row({ id, idempotency_key: `probe:${id}` }) as Record<string, unknown>;
    delete base.attempts;

    const { error } = await admin.from("delivery_log").insert(base);
    expect(error).toBeNull();

    const { data } = await admin.from("delivery_log").select("attempts").eq("id", id).single();
    expect(data?.attempts).toBe(0);
  });

  it("status に想定外の値を入れると CHECK 制約で拒否される（自由文字列にしない）", async () => {
    const { error } = await admin
      .from("delivery_log")
      .insert(row({ idempotency_key: `bad:${crypto.randomUUID()}`, status: "whatever" }));

    expect(error, "CHECK 制約が無い（00024 の未適用を疑う）").not.toBeNull();
    // 23514 = check_violation
    expect(error?.code).toBe("23514");
  });

  it("7つの正規の status はすべて通る", async () => {
    for (const status of [
      "sending",
      "sent",
      "failed",
      "skipped",
      "deferred",
      "draft",
      "confirmed",
    ]) {
      const { error } = await admin
        .from("delivery_log")
        .insert(row({ idempotency_key: `ok:${status}:${crypto.randomUUID()}`, status }));
      expect(error, `${status} が拒否された: ${error?.message}`).toBeNull();
    }
  });

  it("alert_deferred は delivery_type として存在しない（00024 で alert に統合済み）", async () => {
    const { data, error } = await admin
      .from("delivery_log")
      .select("id")
      .eq("delivery_type", "alert_deferred");

    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });
});

describe.skipIf(mode === "skip")("deliver 系の fail-closed を実Functionに当てる (S-2-10)", () => {
  let admin: SupabaseClient;

  beforeAll(() => {
    admin = createClient(SUPABASE_URL, SERVICE_KEY!);
  });

  afterAll(async () => {
    await admin.from("delivery_log").delete().eq("company_id", COMPANY);
  });

  for (const name of ["deliver-pulse", "deliver-weekly", "deliver-alert"]) {
    it(`${name}: 認証情報が無ければ 401（S-4-1）`, async () => {
      const r = await invoke(name, { company_id: COMPANY }, null);
      expect(r.status, `応答: ${r.raw}`).toBe(401);
    });

    it(`${name}: anon キーだけでは 401（JWTを持っているだけでは通らない。S-4-2）`, async () => {
      const r = await invoke(name, { company_id: COMPANY }, ANON_KEY);
      expect(r.status, `応答: ${r.raw}`).toBe(401);
    });
  }

  it("RESEND_API_KEY / RESEND_FROM が無ければ、送信せずに 500 で止まる", async () => {
    const before = await admin
      .from("delivery_log")
      .select("id", { count: "exact", head: true })
      .eq("company_id", COMPANY);

    const r = await invoke(
      "deliver-pulse",
      { company_id: COMPANY, email: TEST_RECIPIENT, target_date: "2026-08-19" },
      SERVICE_KEY,
    );

    expect(r.status, `応答: ${r.raw}`).toBe(500);
    expect(String(r.body.reason)).toContain("RESEND");

    // **予約行すら作らない。** 送るつもりが無いのに予約行を残すと後始末が要るだけ増える
    const after = await admin
      .from("delivery_log")
      .select("id", { count: "exact", head: true })
      .eq("company_id", COMPANY);

    expect(after.count ?? 0).toBe(before.count ?? 0);
  });

  it("不正な target_date は 400（DBにも外部にも触る前に落ちる）", async () => {
    const r = await invoke(
      "deliver-pulse",
      { company_id: COMPANY, email: TEST_RECIPIENT, target_date: "2026-02-30" },
      SERVICE_KEY,
    );
    expect(r.status, `応答: ${r.raw}`).toBe(400);
  });

  it("deliver-alert は event_id が無ければ 400（冪等キーの対象IDが作れない）", async () => {
    const r = await invoke(
      "deliver-alert",
      { company_id: COMPANY, email: TEST_RECIPIENT, event: { metrics: {} }, category: "site_down" },
      SERVICE_KEY,
    );
    expect(r.status, `応答: ${r.raw}`).toBe(400);
    expect(String(r.body.error)).toContain("event_id");
  });
});

/**
 * `asDeliveryDb()` のキャストで捨てた型検査を、**実物で埋める**。
 *
 * `deliverOnce()` の引数型は最小限の構造型だが、実 supabase-js クライアントと
 * 総称型で関係付けると `TS2589` で落ちるため境界でキャストしている。
 * したがって「実クライアントで本当に噛み合うか」は型では分からない。
 * ここで**実 supabase-js クライアント・実DB・実の一意索引**に対して直接動かす。
 * 送信関数は注入するので**メールは出ない**。
 */
describe.skipIf(mode === "skip")("deliverOnce を実クライアント・実DBで動かす", () => {
  let admin: SupabaseClient;
  const company = "00000000-0000-0000-0000-0000000005d2";

  beforeAll(async () => {
    admin = createClient(SUPABASE_URL, SERVICE_KEY!);
    await admin.from("delivery_log").delete().eq("company_id", company);
  });

  afterAll(async () => {
    await admin.from("delivery_log").delete().eq("company_id", company);
  });

  function input(key: string) {
    return {
      companyId: company,
      channel: "email",
      deliveryType: "pulse",
      idempotencyKey: key,
      content: { lines: ["実DB"] },
      now: new Date(),
    };
  }

  it("予約 → 送信 → 更新 が実DBで通り、行が sent になる", async () => {
    const key = `pulse:${company}:2026-08-01`;
    const calls: string[] = [];

    const r = await deliverOnce(asDeliveryDb(admin), input(key), () => {
      calls.push("send");
      return Promise.resolve({ ok: true, emailId: "re_live_probe" });
    });

    expect(r.outcome, JSON.stringify(r)).toBe("sent");
    expect(calls).toEqual(["send"]);

    const { data } = await admin
      .from("delivery_log")
      .select("status, attempts, content, sent_at")
      .eq("idempotency_key", key)
      .single();

    expect(data?.status).toBe("sent");
    expect(data?.attempts).toBe(1);
    expect(data?.content).toMatchObject({ email_id: "re_live_probe" });
    expect(data?.sent_at).toBeTruthy();
  });

  it("同じキーの2回目は送信関数を呼ばない（実の一意索引で止まる）", async () => {
    const key = `pulse:${company}:2026-08-02`;
    await deliverOnce(asDeliveryDb(admin), input(key), () =>
      Promise.resolve({ ok: true, emailId: "re_1" }),
    );

    let sent = false;
    const r = await deliverOnce(asDeliveryDb(admin), input(key), () => {
      sent = true;
      return Promise.resolve({ ok: true, emailId: "re_2" });
    });

    expect(sent, "2通目が送信されてしまった").toBe(false);
    expect(r.outcome).toBe("skipped");
    expect(r).toMatchObject({ reason: "already-sent" });

    const { count } = await admin
      .from("delivery_log")
      .select("id", { count: "exact", head: true })
      .eq("idempotency_key", key);
    expect(count).toBe(1);
  });

  it("送信失敗は failed で記録され、再試行で attempts が増える", async () => {
    const key = `pulse:${company}:2026-08-03`;

    const first = await deliverOnce(asDeliveryDb(admin), input(key), () =>
      Promise.resolve({ ok: false, error: "Resend 500" }),
    );
    expect(first.outcome).toBe("send-failed");

    const second = await deliverOnce(asDeliveryDb(admin), input(key), () =>
      Promise.resolve({ ok: true, emailId: "re_retry" }),
    );
    expect(second.outcome).toBe("sent");

    const { data } = await admin
      .from("delivery_log")
      .select("status, attempts")
      .eq("idempotency_key", key)
      .single();

    expect(data?.status).toBe("sent");
    expect(data?.attempts).toBe(2);
  });

  it("繰り延べ → 送信 が**同一行の UPDATE** になる（別行だと一意制約違反になる）", async () => {
    const key = `alert:${company}:evt_live_probe`;
    const deferInput = { ...input(key), deliveryType: "alert", intent: "defer" as const };

    const deferred = await deliverOnce(asDeliveryDb(admin), deferInput, () =>
      Promise.resolve({ ok: true }),
    );
    expect(deferred.outcome).toBe("deferred");

    const sent = await deliverOnce(
      asDeliveryDb(admin),
      { ...input(key), deliveryType: "alert" },
      () => Promise.resolve({ ok: true, emailId: "re_after_defer" }),
    );

    expect(sent.outcome).toBe("sent");
    expect(sent).toMatchObject({ id: (deferred as { id: string }).id });

    const { data, count } = await admin
      .from("delivery_log")
      .select("id, status", { count: "exact" })
      .eq("idempotency_key", key);

    expect(count, "行が増えている＝同一行の UPDATE になっていない").toBe(1);
    expect(data?.[0].status).toBe("sent");
  });
});
