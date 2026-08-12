import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import {
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
