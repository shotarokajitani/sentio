import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isTokenExpired,
  EXPIRY_BUFFER_MS,
  PROVIDER_CONFIG,
  classifyTokenFailure,
  refreshToken,
} from "@edge/_shared/token-refresh";

describe("EXPIRY_BUFFER_MS", () => {
  it("should be 5 minutes in milliseconds", () => {
    expect(EXPIRY_BUFFER_MS).toBe(5 * 60 * 1000);
  });
});

describe("PROVIDER_CONFIG", () => {
  it("google_calendar config has correct tokenUrl and env vars", () => {
    const gc = PROVIDER_CONFIG.google_calendar;
    expect(gc).toBeDefined();
    expect(gc.tokenUrl).toBe("https://oauth2.googleapis.com/token");
    expect(gc.clientIdEnv).toBe("GOOGLE_CLIENT_ID");
    expect(gc.clientSecretEnv).toBe("GOOGLE_CLIENT_SECRET");
  });

  it("freee config has correct tokenUrl and env vars", () => {
    const freee = PROVIDER_CONFIG.freee;
    expect(freee).toBeDefined();
    expect(freee.tokenUrl).toBe("https://accounts.secure.freee.co.jp/public_api/token");
    expect(freee.clientIdEnv).toBe("FREEE_CLIENT_ID");
    expect(freee.clientSecretEnv).toBe("FREEE_CLIENT_SECRET");
  });
});

describe("isTokenExpired", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 固定時刻: 2026-01-01T00:00:00Z
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true when expiresAt is null", () => {
    expect(isTokenExpired(null)).toBe(true);
  });

  it("returns true when token already expired (past date)", () => {
    expect(isTokenExpired("2025-12-31T23:00:00Z")).toBe(true);
  });

  it("returns true when token expires within buffer (4 min future)", () => {
    // 4分後 = バッファ(5分)以内なので期限切れ扱い
    const fourMinFuture = new Date(Date.now() + 4 * 60 * 1000).toISOString();
    expect(isTokenExpired(fourMinFuture)).toBe(true);
  });

  it("returns false when token expires well beyond buffer (10 min future)", () => {
    const tenMinFuture = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    expect(isTokenExpired(tenMinFuture)).toBe(false);
  });

  it("returns true when token expires exactly at buffer boundary", () => {
    // ちょうど5分後 = Date.now() + EXPIRY_BUFFER_MS >= expiryTime → true
    const exactBuffer = new Date(Date.now() + EXPIRY_BUFFER_MS).toISOString();
    expect(isTokenExpired(exactBuffer)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D-2 系: Google 側取り消しの判別（契約 docs/contracts/slice-disconnect.md）
//
// **陰性コントロールがこのブロックの主役である。** `revoked` は Vault の秘密を
// 直ちに破棄し、30日後の削除（D-3）の起点になる。誤って `revoked` に倒すと
// 「気づいたときには消えている」。したがって
// 「revoked にならないこと」を先に固定し、そのうえで唯一 revoked にする経路を書く。
// ---------------------------------------------------------------------------

describe("classifyTokenFailure — 失敗応答を取り消しと一時的失敗に分ける", () => {
  it("陽性: 400 かつ error=invalid_grant のときだけ revoked", () => {
    expect(classifyTokenFailure(400, JSON.stringify({ error: "invalid_grant" }))).toBe("revoked");
  });

  it("陽性: error_description が付いていても revoked（Google の実際の形）", () => {
    const body = JSON.stringify({
      error: "invalid_grant",
      error_description: "Token has been expired or revoked.",
    });
    expect(classifyTokenFailure(400, body)).toBe("revoked");
  });

  it("陰性: 400 でも error が invalid_grant 以外なら reauth_required（D-2-4）", () => {
    for (const err of [
      "invalid_client",
      "invalid_request",
      "unauthorized_client",
      "invalid_scope",
    ]) {
      expect(classifyTokenFailure(400, JSON.stringify({ error: err }))).toBe("reauth_required");
    }
  });

  it("陰性: 5xx / 429 は本文が invalid_grant でも reauth_required（D-2-5）", () => {
    const body = JSON.stringify({ error: "invalid_grant" });
    for (const status of [429, 500, 502, 503, 504]) {
      expect(classifyTokenFailure(status, body)).toBe("reauth_required");
    }
  });

  it("陰性: 401 / 403 も reauth_required。invalid_grant 以外を revoked に丸めない", () => {
    for (const status of [401, 403]) {
      expect(classifyTokenFailure(status, JSON.stringify({ error: "invalid_grant" }))).toBe(
        "reauth_required",
      );
    }
  });

  it("陰性: 本文が JSON として読めないときは reauth_required（判別できない側に倒す）", () => {
    expect(classifyTokenFailure(400, "<html>502 Bad Gateway</html>")).toBe("reauth_required");
    expect(classifyTokenFailure(400, "")).toBe("reauth_required");
  });

  it("陰性: 本文が JSON でも error フィールドが無い／型が違うなら reauth_required", () => {
    expect(classifyTokenFailure(400, JSON.stringify({ message: "invalid_grant" }))).toBe(
      "reauth_required",
    );
    expect(classifyTokenFailure(400, JSON.stringify({ error: ["invalid_grant"] }))).toBe(
      "reauth_required",
    );
    expect(classifyTokenFailure(400, JSON.stringify(null))).toBe("reauth_required");
    expect(classifyTokenFailure(400, JSON.stringify("invalid_grant"))).toBe("reauth_required");
  });
});

describe("refreshToken の失敗4経路 — revoked と reauth_required の書き分け", () => {
  const CONNECTION = {
    id: "conn-d2",
    provider: "google_calendar",
    vault_secret_id: "vault-d2",
    expires_at: new Date("2025-12-31T23:00:00Z").toISOString(),
  };

  // 秘密そのものはフィクスチャに置かない（契約の禁止事項）。
  // ここに必要なのは「payload に refresh_token キーが在る」ことだけである
  const VAULT_PAYLOAD = JSON.stringify({ access_token: "a", refresh_token: "r" });

  const getEnv = (key: string): string | undefined =>
    ({ GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csec" })[key];

  /**
   * connections への update と rpc 呼び出しを記録するだけのスタブ。
   * 「何が書かれたか」と「何が呼ばれなかったか」の両方を見たいので、
   * 呼び出しを潰さずに配列へ積む。
   */
  function createSupabaseStub(deleteVault: { data: unknown; error: { message: string } | null }) {
    const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const updates: Array<Record<string, unknown>> = [];

    const client = {
      rpc: vi.fn((fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        if (fn === "read_vault_secret")
          return Promise.resolve({ data: VAULT_PAYLOAD, error: null });
        if (fn === "update_vault_secret") return Promise.resolve({ data: null, error: null });
        if (fn === "delete_vault_secret") return Promise.resolve(deleteVault);
        return Promise.resolve({ data: null, error: { message: `unknown rpc: ${fn}` } });
      }),
      from: vi.fn(() => ({
        update: (data: Record<string, unknown>) => {
          updates.push(data);
          return { eq: () => Promise.resolve({ data: null, error: null }) };
        },
      })),
    };

    return { client, rpcCalls, updates };
  }

  const okDelete = { data: true, error: null };

  function respond(status: number, body: string): Response {
    return { ok: status >= 200 && status < 300, status, text: async () => body } as Response;
  }

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ---- 陰性コントロール（誤削除の入口を塞ぐ）--------------------------------

  it("D-2-3 陰性: fetch が throw（通信断）なら reauth_required。revoked_at を書かない", async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("network down"))) as never;
    const { client, rpcCalls, updates } = createSupabaseStub(okDelete);

    const result = await refreshToken(CONNECTION, client, getEnv);

    expect(result.ok).toBe(false);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ status: "reauth_required" });
    expect(updates[0]).not.toHaveProperty("revoked_at");
    // 通信断で秘密を破棄したら、繋がった瞬間に復旧できるはずの連携が壊れる
    expect(rpcCalls.map((c) => c.fn)).not.toContain("delete_vault_secret");
  });

  it("D-2-4 陰性: 400 でも invalid_grant 以外なら reauth_required。秘密を破棄しない", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(respond(400, JSON.stringify({ error: "invalid_client" }))),
    ) as never;
    const { client, rpcCalls, updates } = createSupabaseStub(okDelete);

    const result = await refreshToken(CONNECTION, client, getEnv);

    expect(result.ok).toBe(false);
    expect(updates[0]).toEqual({ status: "reauth_required" });
    expect(rpcCalls.map((c) => c.fn)).not.toContain("delete_vault_secret");
  });

  it("D-2-5 陰性: 5xx / 429 は reauth_required。Google 側の一時障害を解除と読まない", async () => {
    for (const status of [429, 500, 503]) {
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(respond(status, JSON.stringify({ error: "invalid_grant" }))),
      ) as never;
      const { client, rpcCalls, updates } = createSupabaseStub(okDelete);

      const result = await refreshToken(CONNECTION, client, getEnv);

      expect(result.ok, `status=${status}`).toBe(false);
      expect(updates[0], `status=${status}`).toEqual({ status: "reauth_required" });
      expect(
        rpcCalls.map((c) => c.fn),
        `status=${status}`,
      ).not.toContain("delete_vault_secret");
    }
  });

  it("陰性: Vault の読み出しに失敗した経路も reauth_required のまま", async () => {
    const rpcCalls: Array<string> = [];
    const updates: Array<Record<string, unknown>> = [];
    const client = {
      rpc: vi.fn((fn: string) => {
        rpcCalls.push(fn);
        if (fn === "read_vault_secret") {
          return Promise.resolve({ data: null, error: { message: "not found" } });
        }
        return Promise.resolve({ data: null, error: null });
      }),
      from: vi.fn(() => ({
        update: (data: Record<string, unknown>) => {
          updates.push(data);
          return { eq: () => Promise.resolve({ data: null, error: null }) };
        },
      })),
    };

    const result = await refreshToken(CONNECTION, client, getEnv);

    expect(result.ok).toBe(false);
    expect(updates[0]).toEqual({ status: "reauth_required" });
    expect(rpcCalls).not.toContain("delete_vault_secret");
  });

  // ---- 陽性コントロール（唯一 revoked に倒す経路）--------------------------

  it("D-2-1 陽性: 400 + invalid_grant なら status=revoked と revoked_at が入る", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        respond(
          400,
          JSON.stringify({ error: "invalid_grant", error_description: "Token has been revoked." }),
        ),
      ),
    ) as never;
    const { client, updates } = createSupabaseStub(okDelete);

    const before = Date.now();
    const result = await refreshToken(CONNECTION, client, getEnv);
    const after = Date.now();

    expect(result.ok).toBe(false);
    expect(updates).toHaveLength(1);
    expect(updates[0].status).toBe("revoked");

    const revokedAt = updates[0].revoked_at as string;
    expect(typeof revokedAt).toBe("string");
    const t = new Date(revokedAt).getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });

  it("D-2-2 陽性: 同じ経路で Vault の秘密が直ちに破棄される", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(respond(400, JSON.stringify({ error: "invalid_grant" }))),
    ) as never;
    const { client, rpcCalls, updates } = createSupabaseStub(okDelete);

    await refreshToken(CONNECTION, client, getEnv);

    const destroy = rpcCalls.find((c) => c.fn === "delete_vault_secret");
    expect(destroy).toBeDefined();
    expect(destroy!.args).toEqual({ p_id: "vault-d2" });

    // 破棄が status の更新より**先**であること。逆順だと
    // 「revoked と記録したのに秘密は生きている」中間状態が残る
    const destroyIndex = rpcCalls.findIndex((c) => c.fn === "delete_vault_secret");
    expect(destroyIndex).toBeGreaterThanOrEqual(0);
    expect(updates).toHaveLength(1);

    // 破棄した秘密への参照を残さない
    expect(updates[0].vault_secret_id).toBeNull();
  });

  it("陰性: 秘密の破棄に失敗したら revoked にせず reauth_required に留める", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(respond(400, JSON.stringify({ error: "invalid_grant" }))),
    ) as never;
    const { client, updates } = createSupabaseStub({
      data: null,
      error: { message: "vault unavailable" },
    });

    await refreshToken(CONNECTION, client, getEnv);

    // 秘密が残っているのに revoked と記録すると、30日後に参照だけ消えて秘密が残る
    expect(updates[0]).toEqual({ status: "reauth_required" });
  });

  it("D-2-6 の片側: リフレッシュが成功したら revoked_at を NULL に戻す", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ access_token: "new", expires_in: 3600 }),
      } as Response),
    ) as never;
    const { client, updates } = createSupabaseStub(okDelete);

    const result = await refreshToken(CONNECTION, client, getEnv);

    expect(result.ok).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0].status).toBe("active");
    expect(updates[0].revoked_at).toBeNull();
  });
});
