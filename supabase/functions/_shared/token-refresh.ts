/**
 * プロバイダー非依存のOAuthトークンリフレッシュモジュール
 *
 * Why: Google Calendar / freee など複数プロバイダーのリフレッシュロジックを
 * 一箇所に集約し、Edge Function側の重複を排除する。
 * getEnv パラメータ注入により Deno 依存なしでテスト可能。
 */

import { takeError } from "./db.ts";
import { recordConnectionEvent } from "./connection-events.ts";

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
 * 失敗の種別（2026-09-09 に3つへ分けた・発注 ①-2）。
 *
 * | 種別 | いつ | 状態をどうするか |
 * | --- | --- | --- |
 * | `revoked` | 400 かつ `invalid_grant` | 即 `revoked`（従来どおり） |
 * | `reauth_required` | 400 / 401 で `invalid_grant` 以外、Vault の中身が壊れている | 即 `reauth_required` |
 * | `transient` | ネットワーク例外・408・429・5xx・Vault の読み取り失敗 | **状態を変えない。3回続いたら倒す** |
 *
 * **分ける前は、ネットワークが1回瞬断しただけで `reauth_required` になっていた。**
 * その行は `sync-connections` の対象から外れ（`status = 'active'` で絞っている）、
 * 顧客が手で再連携するまで直らない。**7日ごとに「連携が切れています」が届き続ける。**
 */
export type TokenFailureKind = "revoked" | "reauth_required" | "transient";

/** 一時的な失敗を何回続けたら `reauth_required` に倒すか（発注 ①-2） */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** `reauth_required` の行を再試行する間隔（時間）。**1日1回**に絞る */
export const REAUTH_RETRY_HOURS = 24;

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
  // **一時的な失敗。** 状態を変えず、続いたときだけ倒す（発注 ①-2）。
  // 408 は要求のタイムアウト、429 は絞られただけ、5xx は相手側の障害である。
  // どれも「顧客が連携を切った」ではないし、「再認証すれば直る」でもない
  if (status === 408 || status === 429 || status >= 500) return "transient";

  // **知らない状態コードも一時的に倒す。** 402 / 403 / 404 などは相手側の設定や
  // プロキシの都合で出ることがあり、認可の失敗と断定できない。
  // 本当に壊れていれば3回続いて reauth_required に落ちる（18時間で気づく）
  if (status !== 400 && status !== 401) return "transient";

  // 401 は「この資格情報では通らない」。再認証すれば直りうる
  if (status === 401) return "reauth_required";

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "reauth_required";
  }

  if (typeof parsed !== "object" || parsed === null) return "reauth_required";
  return (parsed as { error?: unknown }).error === "invalid_grant" ? "revoked" : "reauth_required";
}

/**
 * 一時的な失敗のあと、状態をどうするかを決める（発注 ①-2）。**実行はしない。**
 *
 * `planPurge` と同じ形で、判断を純関数に閉じてある。
 * **3回目で倒す。** 2回目までは状態を変えず、次の窓（6時間後）に再試行される。
 */
export function planTransientFailure(consecutiveFailures: number): {
  failures: number;
  escalate: boolean;
} {
  const failures = (Number.isFinite(consecutiveFailures) ? consecutiveFailures : 0) + 1;
  return { failures, escalate: failures >= MAX_CONSECUTIVE_FAILURES };
}

/**
 * `reauth_required` の行を再試行してよいか（発注 ①-2）。**1日1回。**
 *
 * 失敗の記録が無い行（この変更より前から `reauth_required` だった行）は
 * **再試行する**。放置され続けるほうが害が大きい。
 */
export function shouldRetryReauth(lastFailureAt: string | null, now: Date): boolean {
  if (!lastFailureAt) return true;
  const at = Date.parse(lastFailureAt);
  if (Number.isNaN(at)) return true;
  return now.getTime() - at >= REAUTH_RETRY_HOURS * 60 * 60 * 1000;
}

/**
 * 同期が成功したときに、状態を戻すか（発注 ①-2・2026-09-09 の検収で足した）。
 *
 * **トークンが有効なまま同期できた経路には、戻す口が無かった。**
 * `sync-connections` は期限切れのときだけ `refreshToken` を呼ぶので、
 * 有効なトークンで取り込めた `reauth_required` の行は倒れたまま残る——
 * **取り込めているのに「連携が切れています」が7日ごとに届く。**
 *
 * `recoveredByRefresh` が true のときは `refreshToken` が既に戻している。
 * ここで二重に書くと、`connection_events` に同じ遷移が2行残る。
 */
export function planSyncRecovery(input: {
  status: string | null | undefined;
  recoveredByRefresh: boolean;
}): { restoreActive: boolean; recordEvent: boolean } {
  const recovering = !input.recoveredByRefresh && input.status === "reauth_required";
  return { restoreActive: recovering, recordEvent: recovering };
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
  company_id: string;
  provider: string;
  /**
   * 遷移を残すために要る（PS-9）。**「どこから」変わったかが無いと、
   * 平常と本物の遷移を区別できない。** 呼び出し元が select に含める
   */
  status?: string | null;
  /** 00007 では NULL 許容。認可が完了しなかった行には秘密が無い */
  vault_secret_id: string | null;
  expires_at: string | null;
  /** 一時的な失敗の連続回数（00037）。呼び出し元が select に含める */
  consecutive_failures?: number | null;
  /** 最後に失敗した時刻（00037）。再試行の間隔を決めるのに使う */
  last_failure_at?: string | null;
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
    // **Vault が読めないのは基盤の失敗**である（中身が壊れているのとは別）。
    // 一時的に倒し、3回続いたときだけ状態を変える（発注 ①-2）
    await markTransientFailure(supabase, connection, "vault read failed");
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
    await markReauthRequired(supabase, connection, "invalid vault payload");
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
    // **ネットワークの瞬断がここに来る。** 1回で連携を切らない（発注 ①-2）
    await markTransientFailure(supabase, connection, "token fetch failed");
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

    if (kind === "transient") {
      const outcome = await markTransientFailure(
        supabase,
        connection,
        `token endpoint ${tokenRes.status}`,
      );
      return {
        ok: false,
        reason: `token endpoint returned ${tokenRes.status} (transient ${outcome.failures}/${MAX_CONSECUTIVE_FAILURES})`,
      };
    }

    await markReauthRequired(supabase, connection, `token endpoint ${tokenRes.status}`);
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
        // **成功したら失敗の記録を消す**（発注 ①-2）。
        // 残したままだと、間隔をあけた失敗が積み上がって誤って倒れる
        consecutive_failures: 0,
        last_failure_at: null,
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

  // **勝手に直ったことを残す**（発注 ①-2）。
  // `reconnected`（人が繋ぎ直した）と別の理由にする——
  // 「顧客が何かしたのか、放っておいて直ったのか」が読めなくなる
  if (connection.status === "reauth_required") {
    const recorded = await recordConnectionEvent(supabase, {
      companyId: connection.company_id,
      provider: connection.provider,
      fromStatus: "reauth_required",
      toStatus: "active",
      reason: "recovered",
    });
    if (!recorded.ok) console.error("connection_events insert failed:", recorded.error);
  }

  // **取り消し中から自力で戻ったときだけ遷移を残す**（PS-9）。
  // 毎回 active → active を書くと、平常の日に行が積み上がって本物の遷移が埋もれる
  if (connection.status && connection.status !== "active") {
    const recorded = await recordConnectionEvent(supabase, {
      companyId: connection.company_id,
      provider: connection.provider,
      fromStatus: connection.status as "revoked" | "reauth_required" | "pending",
      toStatus: "active",
      reason: "reconnected",
    });
    if (!recorded.ok) console.error("connection_events insert failed:", recorded.error);
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
      await markReauthRequired(supabase, connection, "vault destroy failed on revoke");
      return false;
    }
  }

  const recordedRevoke = await recordConnectionEvent(supabase, {
    companyId: connection.company_id,
    provider: connection.provider,
    fromStatus: (connection.status as "active" | "reauth_required" | "pending" | null) ?? null,
    toStatus: "revoked",
    // **取り消しの確認である。** 「更新に失敗した」と混ぜない
    reason: "invalid_grant",
  });
  if (!recordedRevoke.ok) console.error("connection_events insert failed:", recordedRevoke.error);

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

/**
 * 接続ステータスを `reauth_required` に更新するヘルパー。
 *
 * **遷移も同じ場所で残す**（PS-9）。ここを分けると、状態だけ変わって記録が残らない
 * 経路ができる——それが 2026-09-03 に起きたことである。
 */
async function markReauthRequired(
  supabase: any,
  connection: Connection,
  reason: string,
): Promise<void> {
  const error = await takeError(
    supabase.from("connections").update({ status: "reauth_required" }).eq("id", connection.id),
    "token-refresh: mark reauth_required",
  );
  if (error) {
    console.error(`failed to mark reauth_required (${reason}):`, error.message);
  }

  // **すでに reauth_required なら書かない。** 6時間おきに同じ行が積み上がると、
  // 本物の遷移（active → reauth_required）が埋もれる
  if (connection.status === "reauth_required") return;

  const recorded = await recordConnectionEvent(supabase, {
    companyId: connection.company_id,
    provider: connection.provider,
    fromStatus: (connection.status as "active" | "revoked" | "pending" | null) ?? null,
    toStatus: "reauth_required",
    // **取り消しの確認ではない。** Vault の破棄失敗だけは別の理由にする
    reason: reason === "vault destroy failed on revoke" ? "vault_destroy_failed" : "refresh_failed",
  });
  if (!recorded.ok) console.error("connection_events insert failed:", recorded.error);
}

/**
 * 一時的な失敗を数える（発注 ①-2）。**状態は変えない。**
 *
 * 3回続いたときだけ `reauth_required` に倒す。判断は `planTransientFailure`（純関数）にあり、
 * ここは数えて書くだけである。
 *
 * **書けなくても throw しない。** 数えられなかったことで同期そのものを落とすと、
 * 「一時的な失敗に強くする」という目的と逆になる。
 */
async function markTransientFailure(
  supabase: any,
  connection: Connection,
  reason: string,
): Promise<{ failures: number; escalate: boolean }> {
  const outcome = planTransientFailure(connection.consecutive_failures ?? 0);

  const patch: Record<string, unknown> = {
    consecutive_failures: outcome.failures,
    last_failure_at: new Date().toISOString(),
  };

  console.warn(
    `[sentio:sync] 一時的な失敗 provider=${connection.provider} ` +
      `company_id=${connection.company_id} reason=${reason} ` +
      `failures=${outcome.failures}/${MAX_CONSECUTIVE_FAILURES}`,
  );

  if (!outcome.escalate) {
    const error = await takeError(
      supabase.from("connections").update(patch).eq("id", connection.id),
      "token-refresh: count transient failure",
    );
    if (error) console.error("failed to count transient failure:", error.message);
    return outcome;
  }

  // 3回目。**ここで初めて状態を倒す**（記録も残る）
  const error = await takeError(
    supabase.from("connections").update(patch).eq("id", connection.id),
    "token-refresh: count transient failure",
  );
  if (error) console.error("failed to count transient failure:", error.message);

  await markReauthRequired(supabase, connection, `transient x${outcome.failures}: ${reason}`);
  return outcome;
}
