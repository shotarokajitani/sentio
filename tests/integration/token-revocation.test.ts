/**
 * D-2-2 / D-2-6: 取り消しの判別が実DBに何を書くかを確かめる。
 *
 * ユニット（`tests/unit/token-refresh.test.ts`）はスタブ相手なので
 * 「どんな update を投げたか」までしか見えない。**列が実在しなければ書き込みは失敗する。**
 * `revoked_at` は 00027 で足したばかりの列であり、migration が当たっていない環境では
 * ここが落ちる。ユニットが緑でもこれが赤になるのが正しい形である。
 *
 * D-2-2 は「Vault の秘密が**直ちに**破棄される」こと。参照を消しただけでは
 * 破棄したことにならないので、`read_vault_secret` で実体が消えたことを見る。
 *
 * D-2-6 は「再連携が成功したら `revoked_at` が NULL に戻る」こと。
 * ここが効いていないと、繋ぎ直した連携が30日後に削除の対象になる（契約 D-3）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveRlsRunMode } from "../helpers/rls-run-mode";
import { refreshToken, PROVIDER_CONFIG } from "@edge/_shared/token-refresh";
import { upsertVaultToken, GOOGLE_CALENDAR_PROVIDER } from "../../src/security/vault-token";

const SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const mode = resolveRlsRunMode({
  ci: Boolean(process.env.CI),
  anonKey: ANON_KEY,
  serviceKey: SERVICE_KEY,
});

if (mode === "skip") {
  process.stderr.write(
    "\n[token-revocation.test] SKIP: SUPABASE_* が未設定のため未実行（ローカル環境）。\n\n",
  );
  describe.skip("D-2: 取り消しの判別と Vault 破棄（SUPABASE_*未設定のため未実行）", () => {
    it("未実行", () => {});
  });
}

if (mode === "fail") {
  describe("D-2: 取り消しの判別と Vault 破棄 — 実行環境ガード", () => {
    it("CIではSUPABASE_*が注入されていること", () => {
      throw new Error(
        "CI環境で SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定。" +
          "revoked の検証がskipされる状態は fail-open のため失敗として扱う。",
      );
    });
  });
}

if (mode === "run") {
  describe("D-2: invalid_grant を観測したときに実DBへ何が書かれるか", () => {
    let admin: SupabaseClient;
    // CI は同一DBに対してスイートを3回実行する。固定IDだと前回の残骸と干渉する
    const COMPANY_ID = crypto.randomUUID();

    // 本物の秘密は置かない。必要なのは「payload に refresh_token キーが在る」ことだけ
    const DUMMY_PAYLOAD = JSON.stringify({
      access_token: "not-a-real-access-token",
      refresh_token: "not-a-real-refresh-token",
    });

    const getEnv = (key: string): string | undefined =>
      ({ GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csec" })[key];

    // 差し替える前の本物。describe の評価時に1度だけ捕まえる。
    // beforeEach で捕まえると、前のテストの差し替えが残っていた場合にそれを
    // 「本物」として抱え込み、以後ずっと戻せなくなる
    const REAL_FETCH = globalThis.fetch;

    /** 連携を「生きている」状態に戻す。Vault の秘密も作り直す */
    async function connect(): Promise<{ connectionId: string; vaultId: string }> {
      const { vaultId, error } = await upsertVaultToken(admin, COMPANY_ID, DUMMY_PAYLOAD);
      if (error || !vaultId) throw new Error(`upsertVaultToken 失敗: ${error}`);

      // OAuth コールバック（src/app/auth/callback/google/route.ts）と同じ形の upsert。
      // revoked_at: null を含むのが受入基準 D-2-6 の実体
      const { error: upsertErr } = await admin.from("connections").upsert(
        {
          company_id: COMPANY_ID,
          provider: GOOGLE_CALENDAR_PROVIDER,
          vault_secret_id: vaultId,
          status: "active",
          last_refresh: new Date().toISOString(),
          expires_at: new Date(Date.now() - 3600_000).toISOString(),
          revoked_at: null,
        },
        { onConflict: "company_id,provider", ignoreDuplicates: false },
      );
      if (upsertErr) throw new Error(`connections upsert 失敗: ${upsertErr.message}`);

      const row = await readConnection();
      return { connectionId: row.id as string, vaultId };
    }

    async function readConnection() {
      const { data, error } = await admin
        .from("connections")
        .select("id, status, revoked_at, vault_secret_id, expires_at, provider")
        .eq("company_id", COMPANY_ID)
        .eq("provider", GOOGLE_CALENDAR_PROVIDER)
        .single();
      if (error) throw new Error(`connections 読み出し失敗: ${error.message}`);
      return data;
    }

    /**
     * トークンエンドポイントの応答**だけ**を差し替える。
     *
     * **`globalThis.fetch` を丸ごと置き換えてはいけない。**
     * `@supabase/supabase-js` は PostgREST も RPC も `globalThis.fetch` で叩くので、
     * 無条件に差し替えると `read_vault_secret` や `connections` の読み書きまで
     * 偽のトークン応答を受け取る。
     *
     * 2026-08-27 の CI（run 33045925885 / job 98429827497）で実際にそうなった。
     * `refreshToken` の最初のDB呼び出しが「vault read failed」になり、
     * 返ってきた物が PostgREST の応答形ではないので `error.message` が `undefined` になり、
     * 続く `readConnection()` も同じ理由で落ちた。5xx のケースは応答が `headers` を
     * 持たないため postgrest-js が返らず 5秒で打ち切られた。
     * **症状はテスト側の細工であって、実装の不具合ではない。**
     * 同 run の Edge Runtime は `Status=running` / `OOMKilled=false` / `RestartCount=0` で健全だった。
     *
     * 宛先で振り分け、OAuth のトークンエンドポイント以外は本物の `fetch` に通す。
     * 応答も手作りのオブジェクトではなく本物の `Response` を返し、
     * 「こちらが用意した形」に依存する余地を残さない。
     *
     * 宛先の正本は `PROVIDER_CONFIG`。ここに URL を書き写すと、実装が宛先を変えた日に
     * このテストだけが古い URL を見張り続ける。
     */
    const TOKEN_URL = PROVIDER_CONFIG[GOOGLE_CALENDAR_PROVIDER].tokenUrl;
    let tokenEndpointCalls = 0;

    function stubTokenEndpoint(status: number, body: string) {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

        if (url.startsWith(TOKEN_URL)) {
          tokenEndpointCalls += 1;
          return new Response(body, {
            status,
            headers: { "Content-Type": "application/json" },
          });
        }

        return REAL_FETCH(input, init);
      }) as typeof globalThis.fetch;
    }

    beforeAll(() => {
      admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    });

    beforeEach(() => {
      tokenEndpointCalls = 0;
    });

    afterEach(() => {
      globalThis.fetch = REAL_FETCH;
    });

    afterAll(async () => {
      const { data } = await admin
        .from("connections")
        .select("vault_secret_id")
        .eq("company_id", COMPANY_ID);
      for (const row of data ?? []) {
        if (row.vault_secret_id)
          await admin.rpc("delete_vault_secret", { p_id: row.vault_secret_id });
      }
      await admin.from("connections").delete().eq("company_id", COMPANY_ID);
    });

    it("D-2-3 陰性: 5xx では status も revoked_at も動かない（実DB）", async () => {
      const { connectionId, vaultId } = await connect();
      stubTokenEndpoint(503, JSON.stringify({ error: "invalid_grant" }));

      const result = await refreshToken(
        {
          id: connectionId,
          provider: GOOGLE_CALENDAR_PROVIDER,
          vault_secret_id: vaultId,
          expires_at: new Date(Date.now() - 3600_000).toISOString(),
        },
        admin,
        getEnv,
      );

      expect(result.ok).toBe(false);
      // 差し替えが宛先に当たっていること。当たっていなければ本物の Google を叩いている
      expect(tokenEndpointCalls).toBe(1);

      const row = await readConnection();
      expect(row.status).toBe("reauth_required");
      expect(row.revoked_at).toBeNull();
      // 一時障害で秘密を捨てない。再認証すら要らずに復旧できる余地を残す
      expect(row.vault_secret_id).toBe(vaultId);
      const { data: secret } = await admin.rpc("read_vault_secret", { p_id: vaultId });
      expect(secret).not.toBeNull();
    });

    it("D-2-1 / D-2-2 陽性: 400 invalid_grant で revoked になり、Vault の秘密が消える", async () => {
      const { connectionId, vaultId } = await connect();
      stubTokenEndpoint(
        400,
        JSON.stringify({ error: "invalid_grant", error_description: "Token has been revoked." }),
      );

      const before = Date.now();
      const result = await refreshToken(
        {
          id: connectionId,
          provider: GOOGLE_CALENDAR_PROVIDER,
          vault_secret_id: vaultId,
          expires_at: new Date(Date.now() - 3600_000).toISOString(),
        },
        admin,
        getEnv,
      );

      expect(result.ok).toBe(false);
      expect(tokenEndpointCalls).toBe(1);

      const row = await readConnection();
      expect(row.status).toBe("revoked");
      expect(row.revoked_at).not.toBeNull();
      expect(new Date(row.revoked_at as string).getTime()).toBeGreaterThanOrEqual(before - 1000);
      // 破棄済みの秘密への参照を残さない
      expect(row.vault_secret_id).toBeNull();

      // 参照を消しただけでは「破棄した」と言えない。実体が消えていること
      const { data: secret } = await admin.rpc("read_vault_secret", { p_id: vaultId });
      expect(secret).toBeNull();
    });

    it("D-2-6: revoked の後に再連携が成功したら revoked_at が NULL に戻る", async () => {
      // 直前のテストで revoked になっている状態を前提にしない。自分で作る
      const revoked = await connect();
      stubTokenEndpoint(400, JSON.stringify({ error: "invalid_grant" }));
      await refreshToken(
        {
          id: revoked.connectionId,
          provider: GOOGLE_CALENDAR_PROVIDER,
          vault_secret_id: revoked.vaultId,
          expires_at: new Date(Date.now() - 3600_000).toISOString(),
        },
        admin,
        getEnv,
      );
      expect(tokenEndpointCalls).toBe(1);
      expect((await readConnection()).revoked_at).not.toBeNull();

      // 再連携（OAuth コールバックと同じ upsert）
      await connect();

      const row = await readConnection();
      expect(row.status).toBe("active");
      expect(row.revoked_at).toBeNull();
      expect(row.vault_secret_id).not.toBeNull();
    });
  });
}
