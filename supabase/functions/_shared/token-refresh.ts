/**
 * プロバイダー非依存のOAuthトークンリフレッシュモジュール
 *
 * Why: Google Calendar / freee など複数プロバイダーのリフレッシュロジックを
 * 一箇所に集約し、Edge Function側の重複を排除する。
 * getEnv パラメータ注入により Deno 依存なしでテスト可能。
 */

import { takeError } from "./db.ts";

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

/**
 * 失敗の種別。`revoked` は「お客様が連携先で取り消した」と判別できた場合だけ。
 * それ以外はすべて `reauth_required`（再認証すれば直りうる、fail-safe 側）。
 */
export type TokenFailureKind = "revoked" | "reauth_required";

/**
 * トークンエンドポイントが返した失敗応答を、取り消しと一時的失敗に分ける（契約 D-2）。
 *
 * **`revoked` に倒すのは `400` かつ本文の `error` が厳密に `"invalid_grant"` のときだけ。**
 * それ以外は全部 `reauth_required` に落とす。理由は非対称だからである:
 * 取り消しを見逃しても再認証を促すだけで済むが、取り消しでないものを `revoked` と
 * 読むと Vault の秘密を破棄し、30日後の削除（契約 D-3）の起点まで立ってしまう。
 * **消しすぎは取り返しがつかない。** 迷ったら `reauth_required`。
 *
 * status を先に見るのは、`5xx` / `429` の本文に何が入っていても取り消しと読まないため。
 * 障害時のプロキシは上流の本文をそのまま返すことがある。
 *
 * 本文が JSON として読めない場合も `reauth_required`。判別できないことを
 * 「取り消しだった」に丸めない。
 */
export function classifyTokenFailure(status: number, body: string): TokenFailureKind {
  if (status !== 400) return "reauth_required";

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "reauth_required";
  }

  if (typeof parsed !== "object" || parsed === null) return "reauth_required";
  return (parsed as { error?: unknown }).error === "invalid_grant" ? "revoked" : "reauth_required";
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
  /** 00007 では NULL 許容。認可が完了しなかった行には秘密が無い */
  vault_secret_id: string | null;
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
    const kind = classifyTokenFailure(tokenRes.status, body);

    // **本文をそのままログに出さない**（契約 スライスD の禁止事項）。
    // 判別に使った結論（status と kind）だけ残す。応答本文は上流の実装次第で
    // 何が入るか保証が無く、ログは秘密を置いてよい場所ではない
    console.error(`token refresh failed for ${connection.provider}: ${tokenRes.status} (${kind})`);

    if (kind === "revoked") {
      const revoked = await markRevoked(supabase, connection);
      return {
        ok: false,
        reason: revoked
          ? `token endpoint returned ${tokenRes.status} (invalid_grant: revoked)`
          : `token endpoint returned ${tokenRes.status} (invalid_grant: revoke incomplete)`,
      };
    }

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

  // connections テーブルを更新。
  // ここは throw ではなく理由を返す。呼び出し元が status を落とす分岐を持っているため
  const connUpdateError = await takeError(
    supabase
      .from("connections")
      .update({
        expires_at: newExpiresAt,
        last_refresh: new Date().toISOString(),
        status: "active",
        // リフレッシュが通った連携は取り消されていない。取り消しの記録を残したままにすると
        // 30日削除（契約 D-3）が生きている連携のデータを消す起点になる（受入基準 D-2-6）
        revoked_at: null,
      })
      .eq("id", connection.id),
    "token-refresh: connection update",
  );

  if (connUpdateError) {
    console.error("connection update failed:", connUpdateError.message);
    return { ok: false, reason: `connection update failed: ${connUpdateError.message}` };
  }

  return { ok: true, accessToken: newAccessToken, expiresAt: newExpiresAt };
}

/**
 * 取り消しと判別できた連携を `revoked` にし、**Vault の秘密を直ちに破棄する**。
 *
 * プライバシーポリシー §6「連携を解除した場合、アクセストークン・リフレッシュトークンを
 * 直ちに破棄します」の実体（受入基準 D-2-2）。データの削除は30日以内でよいが、
 * **トークンの破棄は「直ちに」と書いてある。** 検知した時点で消す。
 *
 * 破棄を status の更新より先に行うのは disconnect API と同じ理由である。
 * 逆順にすると「`revoked` と記録したのに秘密は生きている」中間状態が残り、
 * しかも `vault_secret_id` を消した後だと**破棄する手がかりごと失う**。
 *
 * 破棄に失敗したら `revoked` にせず `reauth_required` に留める。
 * 秘密が残っているのに「取り消し済み」と記録すると、30日後に参照だけ消えて
 * 秘密が Vault に残り続ける。**約束を守れていない状態を守れたことにしない。**
 *
 * @returns `revoked` を書けたら true。書けなかった（＝ reauth_required に留めた）なら false
 */
async function markRevoked(supabase: any, connection: Connection): Promise<boolean> {
  if (connection.vault_secret_id) {
    // 00025 は p_id が NULL だと例外を上げる。NULL なら破棄すべき物が無いので呼ばない
    const { error: destroyError } = await supabase.rpc("delete_vault_secret", {
      p_id: connection.vault_secret_id,
    });

    if (destroyError) {
      console.error("failed to destroy vault secret on revoke:", destroyError.message);
      await markReauthRequired(supabase, connection.id, "vault destroy failed on revoke");
      return false;
    }
  }

  const error = await takeError(
    supabase
      .from("connections")
      .update({
        status: "revoked",
        revoked_at: new Date().toISOString(),
        // 破棄済みの秘密への参照を残さない。残すと「参照はあるが実体は無い」状態になり、
        // 再連携時の update_vault_secret が空振りしてから作り直す遠回りになる
        vault_secret_id: null,
      })
      .eq("id", connection.id),
    "token-refresh: mark revoked",
  );

  if (error) {
    console.error("failed to mark revoked:", error.message);
    return false;
  }

  return true;
}

/** 接続ステータスを reauth_required に更新するヘルパー */
async function markReauthRequired(
  supabase: any,
  connectionId: string,
  reason: string,
): Promise<void> {
  const error = await takeError(
    supabase.from("connections").update({ status: "reauth_required" }).eq("id", connectionId),
    "token-refresh: mark reauth_required",
  );
  if (error) {
    console.error(`failed to mark reauth_required (${reason}):`, error.message);
  }
}
