import { createHmac, timingSafeEqual } from "crypto";

interface VerifyResult {
  valid: boolean;
  error?: string;
}

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/**
 * 署名の許容時間（秒）。**Stripe の既定と同じ 5 分。**
 *
 * 署名だけを見て時刻を見ないと、**一度盗まれた本文を何日後でも再生できる。**
 * 署名は本文と `t` から作られるので、本文が同じなら署名も同じである。
 */
export const STRIPE_TOLERANCE_SECONDS = 300;

/**
 * Verify Stripe webhook signature (HMAC-SHA256 with timestamp).
 * Header format: t=<timestamp>,v1=<hex_signature>
 *
 * **`v1=` は複数あることがある**（Stripe が鍵を回している最中は新旧2つ来る）。
 * 最初の1つだけを見ると、鍵の入れ替え中に正しい署名を落とす。**全件を走査する。**
 */
export function verifyStripeSignature(
  payload: string,
  signatureHeader: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifyResult {
  if (!signatureHeader) {
    return { valid: false, error: "Missing signature header" };
  }

  const parts = signatureHeader.split(",");
  const tPart = parts.find((p) => p.startsWith("t="));
  const v1Parts = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));

  if (!tPart || v1Parts.length === 0) {
    return { valid: false, error: "Invalid signature format" };
  }

  const timestamp = tPart.slice(2);

  // **時刻が読めない署名は通さない。** 数値でなければ再生かどうかを判定できない
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) {
    return { valid: false, error: "Invalid timestamp" };
  }
  if (Math.abs(nowSeconds - sentAt) > STRIPE_TOLERANCE_SECONDS) {
    return { valid: false, error: "Timestamp outside tolerance" };
  }

  const signedPayload = `${timestamp}.${payload}`;
  const expectedSig = createHmac("sha256", secret).update(signedPayload).digest("hex");

  // **1つでも一致すれば有効。** 早期 return をしないのは、比較回数を署名の数で
  // 揺らさないため（timingSafeEqual を使っている理由と同じ）
  let matched = false;
  for (const received of v1Parts) {
    if (safeCompare(received, expectedSig)) matched = true;
  }

  if (matched) return { valid: true };
  return { valid: false, error: "Signature mismatch" };
}

/**
 * Verify Slack webhook signature (HMAC-SHA256 with v0: prefix).
 * Header: x-slack-signature = v0=<hex>
 */
export function verifySlackSignature(
  body: string,
  signature: string,
  timestamp: number,
  signingSecret: string,
): VerifyResult {
  if (!signature || !signature.startsWith("v0=")) {
    return { valid: false, error: "Invalid signature format" };
  }

  const receivedSig = signature.slice(3);
  const basestring = `v0:${timestamp}:${body}`;
  const expectedSig = createHmac("sha256", signingSecret).update(basestring).digest("hex");

  if (safeCompare(receivedSig, expectedSig)) {
    return { valid: true };
  }
  return { valid: false, error: "Signature mismatch" };
}

/**
 * Verify LINE webhook signature (HMAC-SHA256 base64).
 * Header: x-line-signature = <base64>
 */
export function verifyLineSignature(
  body: string,
  signature: string,
  channelSecret: string,
): VerifyResult {
  if (!signature) {
    return { valid: false, error: "Missing signature" };
  }

  const expectedSig = createHmac("sha256", channelSecret).update(body).digest("base64");

  if (safeCompare(signature, expectedSig)) {
    return { valid: true };
  }
  return { valid: false, error: "Signature mismatch" };
}
