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
        expect(mockFetch.mock.calls[0][0]).toBe(
          "https://oauth2.googleapis.com/token",
        );

        // Assert: update_vault_secret が新トークンを含む
        const vaultUpdateCall = calls.find(
          (c) => c.method === "rpc:update_vault_secret",
        );
        expect(vaultUpdateCall).toBeDefined();
        const storedPayload = JSON.parse(vaultUpdateCall!.args.p_secret);
        expect(storedPayload.access_token).toBe("new-access-token");
        expect(storedPayload.refresh_token).toBe("new-refresh-token");

        // Assert: connections.update が status="active" + expires_at（未来）
        const connUpdateCall = calls.find(
          (c) => c.method === "from:connections.update",
        );
        expect(connUpdateCall).toBeDefined();
        expect(connUpdateCall!.args.data.status).toBe("active");
        expect(
          new Date(connUpdateCall!.args.data.expires_at).getTime(),
        ).toBeGreaterThan(Date.now());
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
        const connUpdateCall = calls.find(
          (c) => c.method === "from:connections.update",
        );
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
      const connUpdateCall = calls.find(
        (c) => c.method === "from:connections.update",
      );
      expect(connUpdateCall).toBeDefined();
      expect(connUpdateCall!.args.data.status).toBe("reauth_required");
    });
  });
});
