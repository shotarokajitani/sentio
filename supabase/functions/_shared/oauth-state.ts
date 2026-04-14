// HMAC-signed state token for OAuth flows.
// state = base64url(payloadJson) + "." + base64url(hmacSha256(payloadJson, secret))

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlEncode(bytes: Uint8Array | string): string {
  const buf = typeof bytes === "string" ? enc.encode(bytes) : bytes;
  let s = btoa(String.fromCharCode(...buf));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return new Uint8Array(sig);
}

export interface StatePayload {
  company_id: string;
  user_id: string;
  provider: "freee" | "moneyforward" | "google_calendar" | "slack" | "chatwork";
  exp: number; // unix seconds
  nonce: string;
  pkce_verifier?: string;
}

function getSecret(): string {
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
}

export async function signState(
  payload: Omit<StatePayload, "exp" | "nonce"> & { pkce_verifier?: string },
): Promise<string> {
  const full: StatePayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + 600, // 10 min
    nonce: crypto.randomUUID(),
  };
  const json = JSON.stringify(full);
  const sig = await hmac(getSecret(), json);
  return `${b64urlEncode(json)}.${b64urlEncode(sig)}`;
}

export async function verifyState(state: string): Promise<StatePayload> {
  const [p, s] = state.split(".");
  if (!p || !s) throw new Error("invalid state format");
  const json = dec.decode(b64urlDecode(p));
  const expectedSig = await hmac(getSecret(), json);
  const givenSig = b64urlDecode(s);
  if (expectedSig.length !== givenSig.length)
    throw new Error("invalid signature");
  let ok = 0;
  for (let i = 0; i < expectedSig.length; i++)
    ok |= expectedSig[i] ^ givenSig[i];
  if (ok !== 0) throw new Error("invalid signature");
  const payload: StatePayload = JSON.parse(json);
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("state expired");
  }
  return payload;
}
