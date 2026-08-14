# OAuthトークンリフレッシュ実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** アクセストークン失効時にrefresh_tokenで自動更新し、同期を継続させる。リフレッシュ失敗時はfail-closedで`reauth_required`に遷移させる。

**Architecture:** プロバイダ非依存の共通トークンリフレッシュモジュール(`_shared/token-refresh.ts`)をEdge Function用に作成。各syncファンクション呼び出し前にこのモジュールでトークンを検証・更新する。`sync-connections` Edge Functionを新設し、pg_cronから全active接続を巡回して同期＋リフレッシュを行う。Vault secretの更新はSQL関数`update_vault_secret`を新設。

**Tech Stack:** TypeScript / Deno (Edge Functions) / Supabase (Vault, Postgres) / Vitest

**対象プロバイダ:** Google Calendar, freee（Chatwork/Slackはコネクタ未実装のため今回スコープ外）

**受入基準マッピング:**

- B-s2-1 → Task 4（陽性コントロール: 期限切れトークン→refresh成功→データ取得成功）
- B-s2-2 → Task 5（陰性コントロール: 無効refresh_token→reauth_required遷移→500系終了）
- B-s2-3 → Task 4/5のテストで検証

---

## ファイル構成

| ファイル                                            | 責務                                               | 操作 |
| --------------------------------------------------- | -------------------------------------------------- | ---- |
| `supabase/migrations/00017_vault_update_helper.sql` | Vault secret更新用SECURITY DEFINER関数             | 新規 |
| `supabase/functions/_shared/token-refresh.ts`       | プロバイダ非依存トークンリフレッシュ共通モジュール | 新規 |
| `supabase/functions/sync-connections/index.ts`      | 全active接続を巡回してsync＋リフレッシュ           | 新規 |
| `src/app/connect/page.tsx`                          | reauth_required状態の表示対応                      | 修正 |
| `tests/unit/token-refresh.test.ts`                  | リフレッシュロジックの単体テスト                   | 新規 |
| `tests/integration/token-refresh.test.ts`           | DB連携テスト（陽性/陰性コントロール）              | 新規 |

---

### Task 1: Vault secret更新SQL関数

**Files:**

- Create: `supabase/migrations/00017_vault_update_helper.sql`

現状`store_vault_secret`（INSERT）と`read_vault_secret`（SELECT）のみ存在。
トークン更新時にVault secretの値を上書きする関数が必要。

- [ ] **Step 1: マイグレーションファイルを作成**

```sql
-- 00017: Vault secret 更新ヘルパー
-- トークンリフレッシュ時にVault内の秘密を上書きする

CREATE OR REPLACE FUNCTION update_vault_secret(p_id UUID, p_secret TEXT)
RETURNS VOID
SECURITY DEFINER
SET search_path = vault, public
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE vault.secrets
  SET secret = p_secret, updated_at = now()
  WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vault secret not found: %', p_id;
  END IF;
END;
$$;
```

- [ ] **Step 2: ローカルでマイグレーション適用確認**

Run: `supabase db reset`
Expected: エラーなく完了。`update_vault_secret`関数が存在。

- [ ] **Step 3: コミット**

```bash
git add supabase/migrations/00017_vault_update_helper.sql
git commit -m "feat(vault): add update_vault_secret helper for token refresh"
```

---

### Task 2: 共通トークンリフレッシュモジュール

**Files:**

- Create: `supabase/functions/_shared/token-refresh.ts`
- Create: `tests/unit/token-refresh.test.ts`

プロバイダごとのトークンエンドポイント・パラメータの差異を吸収する共通モジュール。
Edge Function (Deno) 環境で動作する。テストはVitest (Node) で純粋ロジック部分を検証。

- [ ] **Step 1: テストファイルを作成（Red）**

```typescript
// tests/unit/token-refresh.test.ts
import { describe, it, expect } from "vitest";
import { isTokenExpired, PROVIDER_CONFIG } from "../../supabase/functions/_shared/token-refresh";

describe("isTokenExpired", () => {
  it("期限切れのトークンはtrueを返す", () => {
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    expect(isTokenExpired(pastDate)).toBe(true);
  });

  it("残り5分未満のトークンはtrueを返す（期限間近）", () => {
    const nearFuture = new Date(Date.now() + 4 * 60_000).toISOString(); // 4分後
    expect(isTokenExpired(nearFuture)).toBe(true);
  });

  it("残り5分以上のトークンはfalseを返す", () => {
    const future = new Date(Date.now() + 10 * 60_000).toISOString(); // 10分後
    expect(isTokenExpired(future)).toBe(false);
  });

  it("expires_atがnullの場合はtrueを返す（安全側に倒す）", () => {
    expect(isTokenExpired(null)).toBe(true);
  });
});

describe("PROVIDER_CONFIG", () => {
  it("google_calendarの設定が存在する", () => {
    const config = PROVIDER_CONFIG.google_calendar;
    expect(config).toBeDefined();
    expect(config.tokenUrl).toBe("https://oauth2.googleapis.com/token");
    expect(config.clientIdEnv).toBe("GOOGLE_CLIENT_ID");
    expect(config.clientSecretEnv).toBe("GOOGLE_CLIENT_SECRET");
  });

  it("freeeの設定が存在する", () => {
    const config = PROVIDER_CONFIG.freee;
    expect(config).toBeDefined();
    expect(config.tokenUrl).toBe("https://accounts.secure.freee.co.jp/public_api/token");
    expect(config.clientIdEnv).toBe("FREEE_CLIENT_ID");
    expect(config.clientSecretEnv).toBe("FREEE_CLIENT_SECRET");
  });
});
```

- [ ] **Step 2: テスト実行して失敗を確認**

Run: `pnpm test tests/unit/token-refresh.test.ts`
Expected: FAIL — モジュールが存在しない

- [ ] **Step 3: 共通モジュールを実装**

```typescript
// supabase/functions/_shared/token-refresh.ts

/**
 * プロバイダ非依存のOAuthトークンリフレッシュ共通モジュール。
 * Edge Function (Deno) から使用する。
 * テスト用に純粋関数を named export する。
 */

// --- 定数 ---

const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5分のバッファ

export interface ProviderConfig {
  tokenUrl: string;
  clientIdEnv: string;
  clientSecretEnv: string;
}

export const PROVIDER_CONFIG: Record<string, ProviderConfig> = {
  google_calendar: {
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
  },
  freee: {
    tokenUrl: "https://accounts.secure.freee.co.jp/public_api/token",
    clientIdEnv: "FREEE_CLIENT_ID",
    clientSecretEnv: "FREEE_CLIENT_SECRET",
  },
};

// --- 純粋関数（テスト対象）---

export function isTokenExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return true;
  const expiryTime = new Date(expiresAt).getTime();
  return Date.now() + EXPIRY_BUFFER_MS >= expiryTime;
}

// --- トークンリフレッシュ結果 ---

export interface RefreshResult {
  ok: true;
  accessToken: string;
  expiresAt: string;
}

export interface RefreshError {
  ok: false;
  reason: string;
}

/**
 * refresh_tokenを使ってアクセストークンを更新する。
 * 成功時: Vault secretを上書き + connectionsのexpires_at/last_refreshを更新。
 * 失敗時: connectionsのstatusを'reauth_required'に変更。
 *
 * @param connection - connectionsテーブルの行
 * @param supabase - service_role権限のSupabaseクライアント
 * @param getEnv - 環境変数取得関数（テスタビリティのため注入）
 */
export async function refreshToken(
  connection: {
    id: string;
    provider: string;
    vault_secret_id: string;
    expires_at: string | null;
  },
  supabase: any,
  getEnv: (key: string) => string | undefined = (k) => undefined,
): Promise<RefreshResult | RefreshError> {
  const config = PROVIDER_CONFIG[connection.provider];
  if (!config) {
    return { ok: false, reason: `unknown provider: ${connection.provider}` };
  }

  const clientId = getEnv(config.clientIdEnv);
  const clientSecret = getEnv(config.clientSecretEnv);
  if (!clientId || !clientSecret) {
    return {
      ok: false,
      reason: `missing env: ${config.clientIdEnv} or ${config.clientSecretEnv}`,
    };
  }

  // 1. Vault からトークンペイロードを読む
  const { data: secretText, error: readErr } = await supabase.rpc("read_vault_secret", {
    p_id: connection.vault_secret_id,
  });

  if (readErr || !secretText) {
    await markReauthRequired(supabase, connection.id, "vault read failed");
    return { ok: false, reason: "vault read failed" };
  }

  let tokenPayload: {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  try {
    tokenPayload = JSON.parse(secretText);
  } catch {
    await markReauthRequired(supabase, connection.id, "invalid token payload");
    return { ok: false, reason: "invalid token payload in vault" };
  }

  if (!tokenPayload.refresh_token) {
    await markReauthRequired(supabase, connection.id, "no refresh_token");
    return { ok: false, reason: "no refresh_token stored" };
  }

  // 2. トークンエンドポイントにリフレッシュリクエスト
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokenPayload.refresh_token,
    client_id: clientId,
    client_secret: clientSecret,
  });

  let tokenRes: Response;
  try {
    tokenRes = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (e) {
    await markReauthRequired(supabase, connection.id, `fetch failed: ${(e as Error).message}`);
    return { ok: false, reason: `token endpoint unreachable` };
  }

  if (!tokenRes.ok) {
    const errBody = await tokenRes.text().catch(() => "");
    await markReauthRequired(
      supabase,
      connection.id,
      `refresh failed: ${tokenRes.status} ${errBody}`,
    );
    return {
      ok: false,
      reason: `refresh failed: ${tokenRes.status}`,
    };
  }

  const newTokenData = await tokenRes.json();

  if (!newTokenData.access_token) {
    await markReauthRequired(supabase, connection.id, "refresh response missing access_token");
    return { ok: false, reason: "refresh response missing access_token" };
  }

  // 3. Vault secretを更新
  const updatedPayload = JSON.stringify({
    access_token: newTokenData.access_token,
    // 新しいrefresh_tokenが返された場合は更新、なければ既存を維持
    refresh_token: newTokenData.refresh_token || tokenPayload.refresh_token,
    expires_in: newTokenData.expires_in || 3600,
  });

  const { error: updateErr } = await supabase.rpc("update_vault_secret", {
    p_id: connection.vault_secret_id,
    p_secret: updatedPayload,
  });

  if (updateErr) {
    // Vault更新失敗は致命的だが、新しいaccess_tokenは手元にある
    // → reauth_requiredにはしないが、エラーをログに記録
    console.error(`vault update failed for connection ${connection.id}:`, updateErr.message);
  }

  // 4. connectionsテーブルを更新
  const newExpiresAt = new Date(
    Date.now() + (newTokenData.expires_in || 3600) * 1000,
  ).toISOString();

  await supabase
    .from("connections")
    .update({
      expires_at: newExpiresAt,
      last_refresh: new Date().toISOString(),
      status: "active",
    })
    .eq("id", connection.id);

  return { ok: true, accessToken: newTokenData.access_token, expiresAt: newExpiresAt };
}

/**
 * connectionsのstatusを'reauth_required'に変更する。
 */
async function markReauthRequired(
  supabase: any,
  connectionId: string,
  reason: string,
): Promise<void> {
  console.error(`reauth_required for connection ${connectionId}: ${reason}`);
  await supabase.from("connections").update({ status: "reauth_required" }).eq("id", connectionId);
}
```

- [ ] **Step 4: Vitestがimportできるようresolve aliasを追加**

`vitest.config.ts` の `resolve.alias` に以下を追加:

```typescript
"@edge": path.resolve(__dirname, "supabase/functions"),
```

ただし `_shared/token-refresh.ts` は Deno用なので `Deno.env.get` は使わない設計にしている（`getEnv`引数で注入）。
テスト可能な純粋関数（`isTokenExpired`, `PROVIDER_CONFIG`）のみ直接importする。

- [ ] **Step 5: テスト実行して成功を確認**

Run: `pnpm test tests/unit/token-refresh.test.ts`
Expected: PASS（全4テスト）

- [ ] **Step 6: コミット**

```bash
git add supabase/functions/_shared/token-refresh.ts tests/unit/token-refresh.test.ts vitest.config.ts
git commit -m "feat(token-refresh): add provider-agnostic token refresh module with unit tests"
```

---

### Task 3: sync-connections Edge Function

**Files:**

- Create: `supabase/functions/sync-connections/index.ts`

pg_cronから呼ばれ、全active接続を巡回。トークン期限切れならリフレッシュし、
各プロバイダのAPIからデータを取得してeventsにupsertする。

- [ ] **Step 1: Edge Functionを作成**

```typescript
// supabase/functions/sync-connections/index.ts
// 全active接続を巡回してトークンリフレッシュ＋データ同期。
// pg_cronから日次呼び出し。

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { generateEventId } from "../_shared/event-id.ts";
import { isTokenExpired, refreshToken, PROVIDER_CONFIG } from "../_shared/token-refresh.ts";

const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const FREEE_API_BASE = "https://api.freee.co.jp/api/1";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = getSupabaseAdmin();
  const getEnv = (k: string) => Deno.env.get(k);
  const results: Array<{
    provider: string;
    company_id: string;
    status: string;
    detail?: string;
  }> = [];

  // 全active接続を取得
  const { data: connections, error: fetchErr } = await supabase
    .from("connections")
    .select("id, company_id, provider, vault_secret_id, expires_at, status")
    .eq("status", "active");

  if (fetchErr || !connections) {
    return new Response(
      JSON.stringify({ error: "failed to fetch connections", detail: fetchErr?.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  for (const conn of connections) {
    const config = PROVIDER_CONFIG[conn.provider];
    if (!config) {
      results.push({
        provider: conn.provider,
        company_id: conn.company_id,
        status: "skipped",
        detail: "unknown provider",
      });
      continue;
    }

    // トークン取得（期限切れならリフレッシュ）
    let accessToken: string;

    if (isTokenExpired(conn.expires_at)) {
      const refreshResult = await refreshToken(conn, supabase, getEnv);
      if (!refreshResult.ok) {
        results.push({
          provider: conn.provider,
          company_id: conn.company_id,
          status: "reauth_required",
          detail: refreshResult.reason,
        });
        continue;
      }
      accessToken = refreshResult.accessToken;
    } else {
      // トークンはまだ有効 → Vaultから読む
      const { data: secretText } = await supabase.rpc("read_vault_secret", {
        p_id: conn.vault_secret_id,
      });
      if (!secretText) {
        results.push({
          provider: conn.provider,
          company_id: conn.company_id,
          status: "error",
          detail: "vault read failed",
        });
        continue;
      }
      try {
        const payload = JSON.parse(secretText);
        accessToken = payload.access_token;
      } catch {
        results.push({
          provider: conn.provider,
          company_id: conn.company_id,
          status: "error",
          detail: "invalid vault payload",
        });
        continue;
      }
    }

    // プロバイダ別同期
    try {
      let syncCount = 0;
      if (conn.provider === "google_calendar") {
        syncCount = await syncGoogleCalendar(accessToken, conn.company_id, supabase);
      } else if (conn.provider === "freee") {
        syncCount = await syncFreee(accessToken, conn.company_id, supabase);
      }

      // last_refreshを更新
      await supabase
        .from("connections")
        .update({ last_refresh: new Date().toISOString() })
        .eq("id", conn.id);

      results.push({
        provider: conn.provider,
        company_id: conn.company_id,
        status: "ok",
        detail: `synced ${syncCount} events`,
      });
    } catch (e) {
      results.push({
        provider: conn.provider,
        company_id: conn.company_id,
        status: "error",
        detail: (e as Error).message,
      });
    }
  }

  return new Response(JSON.stringify({ status: "ok", results }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});

// --- Google Calendar 同期 ---
async function syncGoogleCalendar(
  accessToken: string,
  companyId: string,
  supabase: any,
): Promise<number> {
  const now = new Date();
  // 差分同期: 過去7日分のみ（初回は12ヶ月、定期は7日）
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const params = new URLSearchParams({
    timeMin: sevenDaysAgo.toISOString(),
    timeMax: now.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });

  const res = await fetch(`${GOOGLE_CALENDAR_API}/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error(`Calendar API failed: ${res.status}`);
  }

  const calData = await res.json();
  const items = calData.items || [];
  if (items.length === 0) return 0;

  const rows = await Promise.all(
    items.map(
      async (item: {
        summary?: string;
        start?: { dateTime?: string; date?: string };
        end?: { dateTime?: string; date?: string };
        attendees?: { email: string }[];
      }) => {
        const title = item.summary || "(無題)";
        const start = item.start?.dateTime || item.start?.date || now.toISOString();
        const end = item.end?.dateTime || item.end?.date || start;
        const attendees = (item.attendees || []).map((a: { email: string }) => a.email);

        const fingerprint = `calendar:${companyId}`;
        const rowContent = `${title}:${start}:${end}`;
        const eventId = await generateEventId(fingerprint, rowContent);

        return {
          event_id: eventId,
          company_id: companyId,
          occurred_at: start,
          period_start: start,
          period_end: end,
          ingested_at: now.toISOString(),
          source: "google_calendar",
          event_type: "schedule",
          entity_refs: [],
          metrics: { title, attendees },
          sensitivity: "S1",
        };
      },
    ),
  );

  const { error } = await supabase.from("events").upsert(rows, { onConflict: "event_id" });

  if (error) throw new Error(`Calendar events upsert failed: ${error.message}`);
  return rows.length;
}

// --- freee 同期 ---
async function syncFreee(accessToken: string, companyId: string, supabase: any): Promise<number> {
  // freee会社IDを取得
  const meRes = await fetch(`${FREEE_API_BASE}/users/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!meRes.ok) throw new Error(`freee /users/me failed: ${meRes.status}`);

  const meData = await meRes.json();
  const freeeCompanyId = meData.user?.companies?.[0]?.id;
  if (!freeeCompanyId) throw new Error("No freee company found for user");

  const now = new Date();
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const startDate = sevenDaysAgo.toISOString().split("T")[0];
  const endDate = now.toISOString().split("T")[0];

  const params = new URLSearchParams({
    company_id: freeeCompanyId.toString(),
    start_date: startDate,
    end_date: endDate,
    limit: "100",
  });

  const txRes = await fetch(`${FREEE_API_BASE}/deals?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!txRes.ok) throw new Error(`freee /deals failed: ${txRes.status}`);

  const txData = await txRes.json();
  const deals = txData.deals || [];
  if (deals.length === 0) return 0;

  const rows = await Promise.all(
    deals.map(
      async (deal: {
        id: number;
        issue_date: string;
        type: string;
        details?: {
          account_item_name?: string;
          amount?: number;
          tax_code?: number;
        }[];
      }) => {
        const detail = deal.details?.[0];
        const description = detail?.account_item_name || "(不明)";
        const amount = detail?.amount || 0;
        const fingerprint = `freee:${companyId}`;
        const rowContent = `${deal.id}:${deal.issue_date}:${amount}`;
        const eventId = await generateEventId(fingerprint, rowContent);

        return {
          event_id: eventId,
          company_id: companyId,
          occurred_at: `${deal.issue_date}T00:00:00.000Z`,
          ingested_at: now.toISOString(),
          source: "freee",
          event_type: "transaction",
          entity_refs: [],
          metrics: { description, amount, deal_type: deal.type },
          sensitivity: "S1",
        };
      },
    ),
  );

  const { error } = await supabase.from("events").upsert(rows, { onConflict: "event_id" });

  if (error) throw new Error(`freee events upsert failed: ${error.message}`);
  return rows.length;
}
```

- [ ] **Step 2: コミット**

```bash
git add supabase/functions/sync-connections/index.ts
git commit -m "feat(sync): add sync-connections edge function with token refresh"
```

---

### Task 4: 陽性コントロールテスト（B-s2-1 / B-s2-3）

**Files:**

- Create: `tests/integration/token-refresh.test.ts`

期限切れトークンを人為的に設定→sync実行→refresh成功→データ取得成功を検証。
実際のOAuth APIは呼べないため、`refreshToken`関数のfetch部分をモックする。

- [ ] **Step 1: 陽性コントロールテストを作成（Red）**

```typescript
// tests/integration/token-refresh.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { refreshToken, isTokenExpired } from "../../supabase/functions/_shared/token-refresh";

// fetch をモック
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Supabaseクライアントのモック
function createMockSupabase(vaultPayload: string | null) {
  const updateCalls: Array<{ table: string; data: any; filter: any }> = [];
  return {
    client: {
      rpc: vi.fn((funcName: string, args: any) => {
        if (funcName === "read_vault_secret") {
          return { data: vaultPayload, error: null };
        }
        if (funcName === "update_vault_secret") {
          return { data: null, error: null };
        }
        return { data: null, error: { message: `unknown rpc: ${funcName}` } };
      }),
      from: vi.fn((table: string) => ({
        update: vi.fn((data: any) => ({
          eq: vi.fn((col: string, val: string) => {
            updateCalls.push({ table, data, filter: { [col]: val } });
            return { data: null, error: null };
          }),
        })),
      })),
    },
    updateCalls,
  };
}

describe("陽性コントロール: トークンリフレッシュ成功（B-s2-1）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const expiredConnection = {
    id: "conn-001",
    provider: "google_calendar",
    vault_secret_id: "vault-001",
    expires_at: new Date(Date.now() - 60_000).toISOString(), // 1分前に失効
  };

  const vaultPayload = JSON.stringify({
    access_token: "old_access_token",
    refresh_token: "valid_refresh_token",
    expires_in: 3600,
  });

  const mockEnv = (key: string) => {
    const env: Record<string, string> = {
      GOOGLE_CLIENT_ID: "test-client-id",
      GOOGLE_CLIENT_SECRET: "test-client-secret",
    };
    return env[key];
  };

  // 3回再現テスト
  for (let i = 1; i <= 3; i++) {
    it(`リフレッシュ成功 → accessToken更新・expires_at更新（試行${i}/3）`, async () => {
      // Google tokenエンドポイントのモック: 成功レスポンス
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: `new_access_token_${i}`,
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      );

      const { client, updateCalls } = createMockSupabase(vaultPayload);
      const result = await refreshToken(expiredConnection, client, mockEnv);

      // 成功
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.accessToken).toBe(`new_access_token_${i}`);
        expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
      }

      // Vault更新が呼ばれた
      expect(client.rpc).toHaveBeenCalledWith("update_vault_secret", {
        p_id: "vault-001",
        p_secret: expect.stringContaining(`new_access_token_${i}`),
      });

      // connectionsのstatus=active, expires_at更新
      const connUpdate = updateCalls.find(
        (c) => c.table === "connections" && c.data.status === "active",
      );
      expect(connUpdate).toBeDefined();
      expect(connUpdate!.data.expires_at).toBeDefined();
      expect(new Date(connUpdate!.data.expires_at).getTime()).toBeGreaterThan(Date.now());
    });
  }
});
```

- [ ] **Step 2: テスト実行して失敗を確認**

Run: `pnpm test tests/integration/token-refresh.test.ts`
Expected: テストがimportに成功するか確認。純粋関数のimportのみなのでDeno依存なし。

- [ ] **Step 3: テストが通ることを確認**

Run: `pnpm test tests/integration/token-refresh.test.ts`
Expected: PASS（3テスト全通過）

- [ ] **Step 4: コミット**

```bash
git add tests/integration/token-refresh.test.ts
git commit -m "test(token-refresh): add positive control tests (B-s2-1) — 3x reproducible"
```

---

### Task 5: 陰性コントロールテスト（B-s2-2）

**Files:**

- Modify: `tests/integration/token-refresh.test.ts`

無効なrefresh_token→refresh失敗→reauth_required遷移→500系で終了を検証。

- [ ] **Step 1: 陰性コントロールテストを追加（Red→Green）**

`tests/integration/token-refresh.test.ts`に以下を追加:

```typescript
describe("陰性コントロール: リフレッシュ失敗 → reauth_required（B-s2-2）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const expiredConnection = {
    id: "conn-002",
    provider: "google_calendar",
    vault_secret_id: "vault-002",
    expires_at: new Date(Date.now() - 60_000).toISOString(),
  };

  const vaultPayload = JSON.stringify({
    access_token: "old_access_token",
    refresh_token: "invalid_refresh_token",
    expires_in: 3600,
  });

  const mockEnv = (key: string) => {
    const env: Record<string, string> = {
      GOOGLE_CLIENT_ID: "test-client-id",
      GOOGLE_CLIENT_SECRET: "test-client-secret",
    };
    return env[key];
  };

  // 3回再現テスト
  for (let i = 1; i <= 3; i++) {
    it(`リフレッシュ失敗 → reauth_required遷移・ok=false（試行${i}/3）`, async () => {
      // Google tokenエンドポイントのモック: 401エラー（無効なrefresh_token）
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "Token has been revoked" }),
          { status: 401 },
        ),
      );

      const { client, updateCalls } = createMockSupabase(vaultPayload);
      const result = await refreshToken(expiredConnection, client, mockEnv);

      // 失敗
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("refresh failed: 401");
      }

      // connectionsのstatusがreauth_requiredに変更された
      const connUpdate = updateCalls.find(
        (c) => c.table === "connections" && c.data.status === "reauth_required",
      );
      expect(connUpdate).toBeDefined();
      expect(connUpdate!.filter.id).toBe("conn-002");
    });
  }

  it("refresh_tokenが存在しない場合もreauth_required", async () => {
    const noRefreshPayload = JSON.stringify({
      access_token: "old_access_token",
      // refresh_tokenなし
    });

    const { client, updateCalls } = createMockSupabase(noRefreshPayload);
    const result = await refreshToken(expiredConnection, client, mockEnv);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("no refresh_token");
    }

    const connUpdate = updateCalls.find((c) => c.data.status === "reauth_required");
    expect(connUpdate).toBeDefined();
  });
});
```

- [ ] **Step 2: テスト実行して成功を確認**

Run: `pnpm test tests/integration/token-refresh.test.ts`
Expected: PASS（全7テスト — 陽性3 + 陰性3 + refresh_tokenなし1）

- [ ] **Step 3: コミット**

```bash
git add tests/integration/token-refresh.test.ts
git commit -m "test(token-refresh): add negative control tests (B-s2-2) — reauth_required on failure"
```

---

### Task 6: 接続ページにreauth_required状態を表示

**Files:**

- Modify: `src/app/connect/page.tsx`

reauth_requiredの接続に対して、再接続ボタンとエラーメッセージを表示する。

- [ ] **Step 1: badgeStyle関数にreauth_required対応を追加**

`src/app/connect/page.tsx`の`badgeStyle`関数を修正:

```typescript
function badgeStyle(status: string): React.CSSProperties {
  const isError = status === "reauth_required";
  return {
    display: "inline-block",
    padding: "4px 12px",
    background: isError ? "#f44336" : "#4CAF50",
    color: "white",
    borderRadius: 12,
    fontSize: 13,
    fontWeight: "bold",
  };
}
```

- [ ] **Step 2: カレンダーカードにreauth_required対応を追加**

Google Calendar セクションの表示ロジックを修正:

```tsx
{
  calConn ? (
    calConn.status === "reauth_required" ? (
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={badgeStyle("reauth_required")}>要再連携</span>
        <a href={`/api/auth/google?company_id=${COMPANY_ID}`} style={buttonStyle("#4285F4")}>
          再接続
        </a>
      </div>
    ) : (
      <span style={badgeStyle("active")}>接続済み</span>
    )
  ) : (
    <a href={`/api/auth/google?company_id=${COMPANY_ID}`} style={buttonStyle("#4285F4")}>
      接続
    </a>
  );
}
```

freeeセクションにも同様のロジックを追加。

- [ ] **Step 3: typecheckを実行**

Run: `pnpm typecheck`
Expected: エラーなし

- [ ] **Step 4: コミット**

```bash
git add src/app/connect/page.tsx
git commit -m "feat(connect): show reauth_required status with reconnect button (B-s2-2)"
```

---

### Task 7: 全テスト実行・最終検証

- [ ] **Step 1: 全ユニットテスト実行**

Run: `pnpm test`
Expected: 既存テスト + 新規テスト全通過

- [ ] **Step 2: 型チェック**

Run: `pnpm typecheck`
Expected: エラーなし

- [ ] **Step 3: リント**

Run: `pnpm lint`
Expected: エラーなし

- [ ] **Step 4: allowlistチェック**

Run: `pnpm run check:allowlist`
Expected: 新規S2カラムを追加していないのでPASS

- [ ] **Step 5: 最終コミット（必要があれば）**

変更ファイル一覧:

- `supabase/migrations/00017_vault_update_helper.sql` (新規)
- `supabase/functions/_shared/token-refresh.ts` (新規)
- `supabase/functions/sync-connections/index.ts` (新規)
- `src/app/connect/page.tsx` (修正)
- `tests/unit/token-refresh.test.ts` (新規)
- `tests/integration/token-refresh.test.ts` (新規)
- `vitest.config.ts` (修正 — alias追加)
