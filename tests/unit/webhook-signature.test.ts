import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import {
  STRIPE_TOLERANCE_SECONDS,
  verifyStripeSignature,
  verifySlackSignature,
  verifyLineSignature,
} from "../../src/security/webhook-verify";

// Test-only signing helpers (simulate the provider side)
function signStripe(payload: string, secret: string, timestamp: number) {
  const signed = `${timestamp}.${payload}`;
  const hmac = createHmac("sha256", secret).update(signed).digest("hex");
  return `t=${timestamp},v1=${hmac}`;
}

function signSlack(body: string, secret: string, timestamp: number) {
  const base = `v0:${timestamp}:${body}`;
  return "v0=" + createHmac("sha256", secret).update(base).digest("hex");
}

function signLine(body: string, secret: string) {
  return createHmac("sha256", secret).update(body).digest("base64");
}

describe("Webhook signature verification (F3)", () => {
  // Use obviously-fake test values that won't trip the secrets hook
  const testSecret = "test-only-not-a-real-key-abc123";

  describe("Stripe", () => {
    const payload = JSON.stringify({ type: "checkout.session.completed" });

    it("F3: valid signature is accepted", () => {
      const ts = Math.floor(Date.now() / 1000);
      const sig = signStripe(payload, testSecret, ts);
      expect(verifyStripeSignature(payload, sig, testSecret).valid).toBe(true);
    });

    it("F3: invalid signature is rejected", () => {
      expect(verifyStripeSignature(payload, "t=123,v1=bad", testSecret).valid).toBe(false);
    });

    it("F3: missing signature header is rejected", () => {
      expect(verifyStripeSignature(payload, "", testSecret).valid).toBe(false);
    });
  });

  describe("Slack", () => {
    const body = "token=test&text=hello";

    it("F3: valid Slack signature accepted", () => {
      const ts = Math.floor(Date.now() / 1000);
      const sig = signSlack(body, testSecret, ts);
      expect(verifySlackSignature(body, sig, ts, testSecret).valid).toBe(true);
    });

    it("F3: invalid Slack signature rejected", () => {
      const ts = Math.floor(Date.now() / 1000);
      expect(verifySlackSignature(body, "v0=bad", ts, testSecret).valid).toBe(false);
    });
  });

  describe("LINE", () => {
    const body = JSON.stringify({ events: [] });

    it("F3: valid LINE signature accepted", () => {
      const sig = signLine(body, testSecret);
      expect(verifyLineSignature(body, sig, testSecret).valid).toBe(true);
    });

    it("F3: invalid LINE signature rejected", () => {
      expect(verifyLineSignature(body, "badsig", testSecret).valid).toBe(false);
    });
  });
});

/**
 * 署名の時刻（発注 A-4・2026-09-09）。
 *
 * **署名だけを見て時刻を見ないと、一度盗まれた本文を何日後でも再生できる。**
 * 署名は本文と `t` から作られるので、本文が同じなら署名も同じである。
 */
describe("Stripe の署名: 時刻の許容（5分）", () => {
  const SECRET = "stub-signing-value";
  const PAYLOAD = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
  const NOW = 1789000000;

  const headerAt = (t: number) =>
    `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${PAYLOAD}`).digest("hex")}`;

  it("**299 秒前は通る**（境界の内側）", () => {
    const result = verifyStripeSignature(PAYLOAD, headerAt(NOW - 299), SECRET, NOW);
    expect(result.valid).toBe(true);
  });

  it("**301 秒前は落ちる**（境界の外側。署名そのものは正しい）", () => {
    const result = verifyStripeSignature(PAYLOAD, headerAt(NOW - 301), SECRET, NOW);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Timestamp outside tolerance");
  });

  it("未来にずれていても落ちる（時計が進んでいる送信元）", () => {
    expect(verifyStripeSignature(PAYLOAD, headerAt(NOW + 301), SECRET, NOW).valid).toBe(false);
  });

  it("許容そのものは 300 秒である（値を1か所に置く）", () => {
    expect(STRIPE_TOLERANCE_SECONDS).toBe(300);
  });

  it("時刻が数値でなければ落ちる（**再生かどうかを判定できない**）", () => {
    const sig = createHmac("sha256", SECRET).update(`abc.${PAYLOAD}`).digest("hex");
    expect(verifyStripeSignature(PAYLOAD, `t=abc,v1=${sig}`, SECRET, NOW).valid).toBe(false);
  });

  it("**v1 が複数あっても、どれか1つが合えば通る**（鍵の入れ替え中）", () => {
    const good = createHmac("sha256", SECRET).update(`${NOW}.${PAYLOAD}`).digest("hex");
    const header = `t=${NOW},v1=0000000000000000000000000000000000000000000000000000000000000000,v1=${good}`;

    expect(verifyStripeSignature(PAYLOAD, header, SECRET, NOW).valid).toBe(true);
  });

  it("**陰性**: v1 が複数あっても、どれも合わなければ落ちる", () => {
    const header = `t=${NOW},v1=1111111111111111111111111111111111111111111111111111111111111111,v1=2222222222222222222222222222222222222222222222222222222222222222`;

    expect(verifyStripeSignature(PAYLOAD, header, SECRET, NOW).valid).toBe(false);
  });
});
