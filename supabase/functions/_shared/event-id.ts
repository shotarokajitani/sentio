/**
 * Deterministic event_id for Deno Edge Functions.
 * Mirrors src/ingest/csv-parser.ts generateEventId but uses Web Crypto API.
 */
export async function generateEventId(fingerprint: string, rowContent: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${fingerprint}:${rowContent}`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
