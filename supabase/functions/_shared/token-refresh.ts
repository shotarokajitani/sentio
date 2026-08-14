/**
 * プロバイダー非依存のOAuthトークンリフレッシュモジュール
 *
 * Why: Google Calendar / freee など複数プロバイダーのリフレッシュロジックを
 * 一箇所に集約し、Edge Function側の重複を排除する。
 * getEnv パラメータ注入により Deno 依存なしでテスト可能。
 */

export const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

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

/** トークンがバッファ込みで期限切れか判定する純粋関数 */
export function isTokenExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return true;
  const expiryTime = new Date(expiresAt).getTime();
  return Date.now() + EXPIRY_BUFFER_MS >= expiryTime;
}

export interface RefreshResult {
  ok: true;
  accessToken: string;
  expiresAt: string;
}

export interface RefreshError {
  ok: false;
  reason: string;
}

interface Connection {
  id: string;
  provider: string;
  vault_secret_id: string;
  expires_at: string | null;
}

/**
 * OAuthトークンをリフレッシュし、Vault・connectionsテーブルを更新する。
 *
 * Why getEnv: Deno.env.get への直接依存を避け、Node/Vitest からテスト可能にする。
 */
export async function refreshToken(
  connection: Connection,
  supabase: any,
  getEnv: (key: string) => string | undefined,
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

  // Vault からリフレッシュトークンを取得
  const { data: vaultData, error: vaultError } = await supabase.rpc("read_vault_secret", {
    p_id: connection.vault_secret_id,
  });
  if (vaultError || !vaultData) {
    await markReauthRequired(supabase, connection.id, "vault read failed");
    return {
      ok: false,
      reason: `vault read failed: ${vaultError?.message ?? "no data"}`,
    };
  }

  let refreshTokenValue: string;
  try {
    const payload = JSON.parse(vaultData);
    refreshTokenValue = payload.refresh_token;
    if (!refreshTokenValue) throw new Error("refresh_token missing in payload");
  } catch (e: any) {
    await markReauthRequired(supabase, connection.id, "invalid vault payload");
    return { ok: false, reason: `invalid vault payload: ${e.message}` };
  }

  // トークンエンドポイントへリフレッシュリクエスト
  let tokenRes: Response;
  try {
    tokenRes = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshTokenValue,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
  } catch (e: any) {
    await markReauthRequired(supabase, connection.id, "token fetch failed");
    return { ok: false, reason: `token fetch failed: ${e.message}` };
  }

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    console.error(`token refresh failed for ${connection.provider}: ${tokenRes.status} ${body}`);
    await markReauthRequired(supabase, connection.id, `token endpoint ${tokenRes.status}`);
    return {
      ok: false,
      reason: `token endpoint returned ${tokenRes.status}`,
    };
  }

  const tokenData = await tokenRes.json();
  const newAccessToken: string = tokenData.access_token;
  const expiresIn: number = tokenData.expires_in ?? 3600;
  const newExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  // Vault の秘密を更新（新しい refresh_token が返ってきた場合は差し替え）
  const updatedPayload = JSON.stringify({
    access_token: newAccessToken,
    refresh_token: tokenData.refresh_token ?? refreshTokenValue,
  });

  const { error: updateVaultError } = await supabase.rpc("update_vault_secret", {
    p_id: connection.vault_secret_id,
    p_secret: updatedPayload,
  });
  if (updateVaultError) {
    console.error("vault update failed:", updateVaultError.message);
    return { ok: false, reason: `vault update failed: ${updateVaultError.message}` };
  }

  // connections テーブルを更新
  const { error: connUpdateError } = await supabase
    .from("connections")
    .update({
      expires_at: newExpiresAt,
      last_refresh: new Date().toISOString(),
      status: "active",
    })
    .eq("id", connection.id);

  if (connUpdateError) {
    console.error("connection update failed:", connUpdateError.message);
    return { ok: false, reason: `connection update failed: ${connUpdateError.message}` };
  }

  return { ok: true, accessToken: newAccessToken, expiresAt: newExpiresAt };
}

/** 接続ステータスを reauth_required に更新するヘルパー */
async function markReauthRequired(
  supabase: any,
  connectionId: string,
  reason: string,
): Promise<void> {
  const { error } = await supabase
    .from("connections")
    .update({ status: "reauth_required" })
    .eq("id", connectionId);
  if (error) {
    console.error(`failed to mark reauth_required (${reason}):`, error.message);
  }
}
