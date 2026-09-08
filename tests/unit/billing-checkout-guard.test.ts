/**
 * `/api/billing/checkout` の二重購読ガード（2026-09-08 決定）。
 *
 * **押せない画面を作っただけでは足りない。** `checkout.sessions.create` に
 * `customer` を渡していないので、直接叩かれると**新しい Customer と2本目の購読**ができる。
 * さらに webhook が `user_metadata.subscription` を**まるごと上書き**するため、
 * 古い購読はこちらから辿れなくなる。だからサーバ側でも止める（二重の関門の内側）。
 *
 * **関門は否定リストである**（2026-09-08 決定）。列挙式だと列挙漏れと
 * **Stripe が将来足す状態**がそのまま素通りする——`status = 'active'` の行だけを
 * 読んでいた 09-03 の沈黙と同じ構造なので、繰り返さない。
 *
 * ここは**通り抜けないこと**が主役なので、陰性コントロールを対で置く。
 * 通り抜けたことは「設定の欠落（500）まで進んだ」ことで見る——
 * **試験から Stripe を叩かない**（本番にも試験にも購読を作らない）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextResponse } from "next/server";
import { PORTAL_ENDPOINT } from "@/lib/billing/portal";
import { hasStripeSubscription, needsPaymentUpdate } from "@/lib/billing/subscription-state";

/** モックから読む可変の状態。`vi.mock` は巻き上がるので、値は後から差し替える */
const session = { subscriptionStatus: null as string | null };

vi.mock("@/lib/auth/company", () => ({
  getAuthedContext: async () => ({
    // 実在しない値に固定する（契約 停止点。実在の値をフィクスチャに書かない）
    companyId: "00000000-0000-0000-0000-000000000000",
    email: "nobody@example.invalid",
    siteUrl: null,
    subscriptionStatus: session.subscriptionStatus,
    stripeCustomerId: null,
    supabase: null,
  }),
  unauthorized: () => NextResponse.json({ error: "unauthorized" }, { status: 401 }),
}));

async function post(status: string | null): Promise<Response> {
  session.subscriptionStatus = status;
  const { POST } = await import("@/app/api/billing/checkout/route");
  return POST();
}

beforeEach(() => {
  // **Stripe を叩かせない。** 門を通り抜けたら設定の欠落で 500 になり、
  // それが「通り抜けた」ことの証拠になる
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  vi.stubEnv("STRIPE_PRICE_STANDARD", "");
  vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("すでに購読がある状態では checkout を作らない（409）", () => {
  // 2026-09-08 より前から見ていた3つ。**この3件は残す**（退行の目印になる）
  it.each(["active", "past_due", "trialing"])("status=%s は 409 で止める", async (status) => {
    const res = await post(status);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(409);
    expect(body.error).toBe("already_subscribed");
    // **行き先を返す。** past_due の直し方は「支払い方法の更新」であって新規購読ではない
    expect(body.portal).toBe(PORTAL_ENDPOINT);
    expect(body.status).toBe(status);
  });

  it("409 の本文に Stripe の値を混ぜない（内部事情を出さない）", async () => {
    const text = await (await post("active")).text();

    for (const leak of ["sk_", "cus_", "sub_", "price_", "STRIPE"]) {
      expect(text, leak).not.toContain(leak);
    }
  });
});

describe("Stripe の8状態を1つずつ通す（**列挙漏れをここで殺す**）", () => {
  /**
   * Stripe の購読の状態は8つ。**購読が存在しないのは2つだけ**である。
   * 残り6つは Stripe 側に購読の実体が残っているので、checkout を通せば2本目ができる。
   */
  const STRIPE_STATUSES: [string, boolean][] = [
    ["incomplete", true], // 決済の途中。**購読の行は存在する**
    ["incomplete_expired", false], // 確定しないまま期限切れ。購読は残らない
    ["trialing", true],
    ["active", true],
    ["past_due", true],
    ["canceled", false], // 終端。**新しく始めるのが正しい**
    ["unpaid", true], // past_due の再試行が尽きた後。購読は残っている
    ["paused", true],
  ];

  it.each(STRIPE_STATUSES)("status=%s → 止める=%s", async (status, blocked) => {
    const res = await post(status);

    expect(res.status).toBe(blocked ? 409 : 500);
  });

  it("**購読が存在しないのは2つだけ**（数がずれたら決定が変わっている）", () => {
    expect(STRIPE_STATUSES.filter(([, blocked]) => !blocked).map(([s]) => s)).toEqual([
      "incomplete_expired",
      "canceled",
    ]);
  });
});

describe("**陰性コントロール**: 否定リストであること（列挙式に戻したら赤くなる）", () => {
  /**
   * **Stripe がまだ持っていない状態**を1つ与える。
   *
   * 否定リスト（`canceled` / `incomplete_expired` 以外は止める）なら**既定で止まる。**
   * 列挙式（`active` / `past_due` / `trialing` を止める）に戻すと**素通りして 500 になり、
   * この試験が赤くなる。** それがこの試験の役目である。
   */
  it.each(["paused", "grace_period", "status_stripe_has_not_shipped_yet"])(
    "知らない状態 %s も既定で止める",
    async (status) => {
      const res = await post(status);

      expect(res.status).toBe(409);
    },
  );

  it("記録が無いときだけ通す（**ここを止めると誰も購読を始められない**）", async () => {
    for (const status of [null, ""]) {
      const res = await post(status);

      // 通り抜けた先は設定の欠落。**ここまで来たことが「止めていない」ことの証拠**
      expect(res.status, `status=${JSON.stringify(status)}`).toBe(500);
    }
  });
});

/**
 * 判定そのもの（`lib/billing/subscription-state.ts`）。
 *
 * **画面とサーバが同じ関数を見ている**ことが要るので、ここで直接固定する。
 * 片方だけ直すと「押せる画面と 409 で止まる API」に割れる。
 */
describe("判定は1か所にある", () => {
  it("枠の判定（plan.ts）とは別物である。**集合が違うのは意図**", () => {
    // 枠は active / trialing だけに与える。購読の実体は past_due にも残っている
    expect(hasStripeSubscription("past_due")).toBe(true);
    expect(hasStripeSubscription("unpaid")).toBe(true);
    expect(hasStripeSubscription("canceled")).toBe(false);
    expect(hasStripeSubscription("incomplete_expired")).toBe(false);
  });

  it("記録が無いとき（null / 空白）は購読なし", () => {
    expect(hasStripeSubscription(null)).toBe(false);
    expect(hasStripeSubscription(undefined)).toBe(false);
    expect(hasStripeSubscription("   ")).toBe(false);
  });

  it("支払い方法の更新が要るのは past_due と unpaid の2つだけ", () => {
    expect(needsPaymentUpdate("past_due")).toBe(true);
    expect(needsPaymentUpdate("unpaid")).toBe(true);
    // **陰性コントロール**: 購読中や試用中に「お支払いを確認できていません」を出さない
    for (const status of ["active", "trialing", "incomplete", "paused", "canceled", null]) {
      expect(needsPaymentUpdate(status), `status=${status}`).toBe(false);
    }
  });
});
