/**
 * token-refresh 陽性/陰性コントロールテスト (B-s2-1 / B-s2-2)
 *
 * Why: OAuthトークンリフレッシュの成功・失敗パスが3回連続で再現可能なことを検証し、
 * 非決定性バグを防ぐ。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { refreshToken } from "@edge/_shared/token-refresh";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSupabase(vaultPayload: string | null) {
  const calls: Array<{ method: string; args: any }> = [];

  const client = {
    rpc: vi.fn((funcName: string, args: any) => {
      calls.push({ method: `rpc:${funcName}`, args });
      if (funcName === "read_vault_secret") {
        return Promise.resolve({ data: vaultPayload, error: null });
      }
      if (funcName === "update_vault_secret") {
        return Promise.resolve({ data: null, error: null });
      }
      return Promise.resolve({
        data: null,
        error: { message: `unknown rpc: ${funcName}` },
      });
    }),
    from: vi.fn((table: string) => ({
      // 遷移の記録（PS-9）。**状態だけ変わって記録が残らない経路を作らない**
      insert: vi.fn((row: any) => {
        calls.push({ method: `from:${table}.insert`, args: { data: row } });
        return Promise.resolve({ data: null, error: null });
      }),
      update: vi.fn((data: any) => ({
        eq: vi.fn((col: string, val: string) => {
          calls.push({
            method: `from:${table}.update`,
            args: { data, filter: { [col]: val } },
          });
          return Promise.resolve({ data: null, error: null });
        }),
      })),
    })),
  };

  return { client, calls };
}

const EXPIRED_CONNECTION = {
  id: "conn-001",
  company_id: "c0000000-0000-4000-8000-000000000001",
  status: "active",
  provider: "google_calendar",
  vault_secret_id: "vault-secret-001",
  expires_at: new Date(Date.now() - 3600_000).toISOString(), // 1時間前
};

const VAULT_PAYLOAD = JSON.stringify({
  access_token: "old-access-token",
  refresh_token: "valid-refresh-token",
});

const getEnv = (key: string): string | undefined => {
  const env: Record<string, string> = {
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
  };
  return env[key];
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("token-refresh", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // =========================================================================
  // B-s2-1: 陽性コントロール — リフレッシュ成功パス（3回再現）
  // =========================================================================
  describe("B-s2-1: 陽性コントロール — 期限切れトークンのリフレッシュ成功", () => {
    for (let i = 1; i <= 3; i++) {
      it(`試行 ${i}/3: 新しいアクセストークンを取得し、Vault・connectionsを更新する`, async () => {
        // Arrange
        const { client, calls } = createMockSupabase(VAULT_PAYLOAD);

        const mockFetch = vi.fn().mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: "new-access-token",
            expires_in: 3600,
            refresh_token: "new-refresh-token",
          }),
        });
        vi.stubGlobal("fetch", mockFetch);

        // Act
        const result = await refreshToken(EXPIRED_CONNECTION, client, getEnv);

        // Assert: 戻り値
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("unreachable");
        expect(result.accessToken).toBe("new-access-token");
        expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());

        // Assert: fetchが正しいエンドポイントに呼ばれた
        expect(mockFetch).toHaveBeenCalledOnce();
        expect(mockFetch.mock.calls[0][0]).toBe("https://oauth2.googleapis.com/token");

        // Assert: update_vault_secret が新トークンを含む
        const vaultUpdateCall = calls.find((c) => c.method === "rpc:update_vault_secret");
        expect(vaultUpdateCall).toBeDefined();
        const storedPayload = JSON.parse(vaultUpdateCall!.args.p_secret);
        expect(storedPayload.access_token).toBe("new-access-token");
        expect(storedPayload.refresh_token).toBe("new-refresh-token");

        // Assert: connections.update が status="active" + expires_at（未来）
        const connUpdateCall = calls.find((c) => c.method === "from:connections.update");
        expect(connUpdateCall).toBeDefined();
        expect(connUpdateCall!.args.data.status).toBe("active");
        expect(new Date(connUpdateCall!.args.data.expires_at).getTime()).toBeGreaterThan(
          Date.now(),
        );
      });
    }
  });

  // =========================================================================
  // B-s2-2: 陰性コントロール — リフレッシュ失敗パス（3回再現）
  // =========================================================================
  describe("B-s2-2: 陰性コントロール — トークンエンドポイントが401を返す", () => {
    for (let i = 1; i <= 3; i++) {
      it(`試行 ${i}/3: ok=false を返し、接続を reauth_required にする`, async () => {
        // Arrange
        const { client, calls } = createMockSupabase(VAULT_PAYLOAD);

        const mockFetch = vi.fn().mockResolvedValueOnce({
          ok: false,
          status: 401,
          text: async () => '{"error":"invalid_grant"}',
        });
        vi.stubGlobal("fetch", mockFetch);

        // Act
        const result = await refreshToken(EXPIRED_CONNECTION, client, getEnv);

        // Assert: 戻り値
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.reason).toContain("401");

        // Assert: connections.update が status="reauth_required" で呼ばれた
        const connUpdateCall = calls.find((c) => c.method === "from:connections.update");
        expect(connUpdateCall).toBeDefined();
        expect(connUpdateCall!.args.data.status).toBe("reauth_required");
      });
    }
  });

  // =========================================================================
  // 追加: refresh_token が存在しない場合も reauth_required になること
  // =========================================================================
  describe("陰性: Vaultペイロードにrefresh_tokenがない場合", () => {
    it("ok=false を返し、接続を reauth_required にする", async () => {
      // Arrange: refresh_token キーがないペイロード
      const payloadWithoutRefresh = JSON.stringify({
        access_token: "old-access-token",
      });
      const { client, calls } = createMockSupabase(payloadWithoutRefresh);

      // fetchは呼ばれないはずだが念のためモック
      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);

      // Act
      const result = await refreshToken(EXPIRED_CONNECTION, client, getEnv);

      // Assert
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toContain("refresh_token");

      // fetchは呼ばれていない（Vault段階で失敗）
      expect(mockFetch).not.toHaveBeenCalled();

      // connections が reauth_required に更新された
      const connUpdateCall = calls.find((c) => c.method === "from:connections.update");
      expect(connUpdateCall).toBeDefined();
      expect(connUpdateCall!.args.data.status).toBe("reauth_required");
    });
  });
});

/**
 * 一時的な失敗を、連携が切れたことと混ぜない（発注 ①-2・2026-09-09）。
 *
 * **直す前は、503 が1回返っただけで `reauth_required` になっていた。**
 * その行は `sync-connections` の対象から外れ（`status = 'active'` で絞っている）、
 * 顧客が手で再連携するまで直らない。7日ごとに「連携が切れています」が届き続ける。
 */
describe("①-2: 一時的な失敗（transient）", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const failing = (status: number) =>
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      text: async () => "Service Unavailable",
    });

  /** `connections.update` に渡した中身を取り出す */
  const updates = (calls: Array<{ method: string; args: any }>) =>
    calls.filter((c) => c.method === "from:connections.update").map((c) => c.args.data);

  it("**503 を1回返しても active のまま。** consecutive_failures だけが 1 になる", async () => {
    const { client, calls } = createMockSupabase(VAULT_PAYLOAD);
    vi.stubGlobal("fetch", failing(503));

    const result = await refreshToken(
      { ...EXPIRED_CONNECTION, consecutive_failures: 0 },
      client,
      getEnv,
    );

    expect(result.ok).toBe(false);

    const patches = updates(calls);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ consecutive_failures: 1 });
    // **状態を変えていない**。ここが要件の芯である
    expect(patches[0]).not.toHaveProperty("status");
    // 遷移の記録も残さない（何も遷移していない）
    expect(calls.some((c) => c.method === "from:connection_events.insert")).toBe(false);
  });

  it("**503 が3回続くと reauth_required に倒れる**", async () => {
    const { client, calls } = createMockSupabase(VAULT_PAYLOAD);
    vi.stubGlobal("fetch", failing(503));

    // 3回目の呼び出し（それまでに2回失敗している行）
    await refreshToken({ ...EXPIRED_CONNECTION, consecutive_failures: 2 }, client, getEnv);

    const patches = updates(calls);
    expect(patches.some((p) => p.consecutive_failures === 3)).toBe(true);
    expect(patches.some((p) => p.status === "reauth_required")).toBe(true);

    // **倒したことは記録に残す**（PS-9）
    const event = calls.find((c) => c.method === "from:connection_events.insert");
    expect(event?.args.data).toMatchObject({ to_status: "reauth_required" });
  });

  it("**陰性**: ネットワークの例外も1回では倒れない", async () => {
    const { client, calls } = createMockSupabase(VAULT_PAYLOAD);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unreachable")));

    await refreshToken({ ...EXPIRED_CONNECTION, consecutive_failures: 0 }, client, getEnv);

    const patches = updates(calls);
    expect(patches[0]).toMatchObject({ consecutive_failures: 1 });
    expect(patches[0]).not.toHaveProperty("status");
  });

  it("**invalid_grant は従来どおり即 revoked**（数えない）", async () => {
    const { client, calls } = createMockSupabase(VAULT_PAYLOAD);
    // 取り消しの経路は Vault の破棄を通る。既定のモックは未知の rpc を失敗にするので足す
    const baseRpc = client.rpc;
    client.rpc = vi.fn((fn: string, args: any) => {
      if (fn === "delete_vault_secret") {
        calls.push({ method: "rpc:delete_vault_secret", args });
        return Promise.resolve({ data: true, error: null });
      }
      return baseRpc(fn, args);
    }) as never;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: "invalid_grant" }),
      }),
    );

    await refreshToken({ ...EXPIRED_CONNECTION, consecutive_failures: 0 }, client, getEnv);

    const patches = updates(calls);
    expect(patches.some((p) => p.status === "revoked")).toBe(true);
    // **一時的な失敗として数えない。** 取り消しは1回で確定する
    expect(patches.some((p) => p.consecutive_failures !== undefined)).toBe(false);
  });

  it("成功したら失敗の記録を消す（間隔をあけた失敗が積み上がらない）", async () => {
    const { client, calls } = createMockSupabase(VAULT_PAYLOAD);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: "new", expires_in: 3600 }),
      }),
    );

    await refreshToken({ ...EXPIRED_CONNECTION, consecutive_failures: 2 }, client, getEnv);

    const patches = updates(calls);
    expect(patches[0]).toMatchObject({
      status: "active",
      consecutive_failures: 0,
      last_failure_at: null,
    });
  });

  it("**reauth_required の行が成功したら active に戻り、recovered が残る**", async () => {
    const { client, calls } = createMockSupabase(VAULT_PAYLOAD);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: "new", expires_in: 3600 }),
      }),
    );

    const result = await refreshToken(
      { ...EXPIRED_CONNECTION, status: "reauth_required", consecutive_failures: 3 },
      client,
      getEnv,
    );

    expect(result.ok).toBe(true);
    expect(updates(calls)[0]).toMatchObject({ status: "active", consecutive_failures: 0 });

    // **「人が繋ぎ直した」と「勝手に直った」を別の理由にする**
    const event = calls.find((c) => c.method === "from:connection_events.insert");
    expect(event?.args.data).toMatchObject({
      from_status: "reauth_required",
      to_status: "active",
      reason: "recovered",
    });
  });

  it("**陰性**: もともと active だった行に recovered を書かない（平常を遷移にしない）", async () => {
    const { client, calls } = createMockSupabase(VAULT_PAYLOAD);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: "new", expires_in: 3600 }),
      }),
    );

    await refreshToken(EXPIRED_CONNECTION, client, getEnv);

    expect(calls.some((c) => c.method === "from:connection_events.insert")).toBe(false);
  });
});
