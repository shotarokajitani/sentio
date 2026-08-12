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
 * Verify Stripe webhook signature (HMAC-SHA256 with timestamp).
 * Header format: t=<timestamp>,v1=<hex_signature>
 */
export function verifyStripeSignature(
  payload: string,
  signatureHeader: string,
  secret: string,
): VerifyResult {
  if (!signatureHeader) {
    return { valid: false, error: "Missing signature header" };
  }

  const parts = signatureHeader.split(",");
  const tPart = parts.find((p) => p.startsWith("t="));
  const v1Part = parts.find((p) => p.startsWith("v1="));

  if (!tPart || !v1Part) {
    return { valid: false, error: "Invalid signature format" };
  }

  const timestamp = tPart.slice(2);
  const receivedSig = v1Part.slice(3);

  const signedPayload = `${timestamp}.${payload}`;
  const expectedSig = createHmac("sha256", secret)
    .update(signedPayload)
    .digest("hex");

  if (safeCompare(receivedSig, expectedSig)) {
    return { valid: true };
  }
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
  const expectedSig = createHmac("sha256", signingSecret)
    .update(basestring)
    .digest("hex");

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

  const expectedSig = createHmac("sha256", channelSecret)
    .update(body)
    .digest("base64");

  if (safeCompare(signature, expectedSig)) {
    return { valid: true };
  }
  return { valid: false, error: "Signature mismatch" };
}
