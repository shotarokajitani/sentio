import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveRlsRunMode } from "../helpers/rls-run-mode";
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
    "\n[vault-token-rotation] SKIP: SUPABASE_* が未設定のため未実行（ローカル環境）。\n\n",
  );
}

if (mode === "skip") {
  describe.skip("Vaultトークンの再連携（SUPABASE_*未設定のため未実行）", () => {
    it("未実行", () => {});
  });
}

if (mode === "run") {
  describe("Vaultトークンの再連携で同名シークレットが増えない", () => {
    let admin: SupabaseClient;
    // 実ユーザーIDと衝突しない固定UUID（テスト専用）
    const COMPANY_ID = "0000000a-0000-4000-8000-00000000d001";

    /** OAuthコールバックと同じ順序を再現する: Vault保存 → connections upsert */
    async function simulateReconnect(payload: string): Promise<string> {
      const { vaultId, error } = await upsertVaultToken(admin, COMPANY_ID, payload);
      if (error || !vaultId) throw new Error(`upsertVaultToken 失敗: ${error}`);

      const { error: connErr } = await admin.from("connections").upsert(
        {
          company_id: COMPANY_ID,
          provider: GOOGLE_CALENDAR_PROVIDER,
          vault_secret_id: vaultId,
          scopes: ["calendar.readonly"],
          status: "active",
          last_refresh: new Date().toISOString(),
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        },
        { onConflict: "company_id,provider", ignoreDuplicates: false },
      );
      if (connErr) throw new Error(`connections upsert 失敗: ${connErr.message}`);
      return vaultId;
    }

    async function readSecret(vaultId: string): Promise<string | null> {
      const { data, error } = await admin.rpc("read_vault_secret", { p_id: vaultId });
      if (error) throw new Error(`read_vault_secret 失敗: ${error.message}`);
      return data as string | null;
    }

    beforeAll(() => {
      admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    });

    afterAll(async () => {
      await admin
        .from("connections")
        .delete()
        .eq("company_id", COMPANY_ID)
        .eq("provider", GOOGLE_CALENDAR_PROVIDER);
    });

    it("初回連携でシークレットが作られる", async () => {
      const id = await simulateReconnect("payload-1");
      expect(id).toBeTruthy();
      expect(await readSecret(id)).toBe("payload-1");
    });

    it("再連携3回でも vault_secret_id が変わらず、値だけが更新される", async () => {
      const first = await simulateReconnect("payload-1");

      const second = await simulateReconnect("payload-2");
      expect(second).toBe(first); // 新規作成されていない＝同名シークレットが増えていない
      expect(await readSecret(second)).toBe("payload-2");

      const third = await simulateReconnect("payload-3");
      expect(third).toBe(first);
      expect(await readSecret(third)).toBe("payload-3");

      const fourth = await simulateReconnect("payload-4");
      expect(fourth).toBe(first);
      expect(await readSecret(fourth)).toBe("payload-4");
    });

    it("再連携後も connections は1行のまま", async () => {
      await simulateReconnect("payload-a");
      await simulateReconnect("payload-b");
      await simulateReconnect("payload-c");

      const { data, error } = await admin
        .from("connections")
        .select("id, vault_secret_id")
        .eq("company_id", COMPANY_ID)
        .eq("provider", GOOGLE_CALENDAR_PROVIDER);

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it("参照先シークレットが消えていたら新規作成にフォールバックする", async () => {
      await simulateReconnect("payload-x");

      // 参照先が消えた状況を、存在しないUUIDを指すように書き換えて再現する
      const ghost = "00000000-0000-4000-8000-0000000000ff";
      const { error: upd } = await admin
        .from("connections")
        .update({ vault_secret_id: ghost })
        .eq("company_id", COMPANY_ID)
        .eq("provider", GOOGLE_CALENDAR_PROVIDER);
      expect(upd).toBeNull();

      const recovered = await simulateReconnect("payload-y");
      expect(recovered).not.toBe(ghost);
      expect(await readSecret(recovered)).toBe("payload-y");
    });
  });
}
