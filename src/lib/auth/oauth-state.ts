import { randomBytes, timingSafeEqual } from "crypto";

/**
 * OAuth の state をCSRFトークンとして生成する。
 *
 * 以前は company_id をそのまま state に入れていた。これは二重に問題で、
 * (1) stateがCSRF対策として機能せず、(2) 第三者が任意の company_id を指定して
 * 他社に接続を紐付けられた。state は「この認可要求を始めたのは自分だ」という
 * 証明にのみ使い、company_id はコールバック側でセッションから取る。
 */
export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function oauthStateCookieName(provider: string): string {
  return `sentio_oauth_state_${provider}`;
}

/** cookieに保存した state と、コールバックで返ってきた state を比較する */
export function isMatchingState(
  cookieState: string | null | undefined,
  callbackState: string | null | undefined,
): boolean {
  if (!cookieState || !callbackState) return false;

  const a = Buffer.from(cookieState);
  const b = Buffer.from(callbackState);
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

/** 認可要求の往復に必要な時間。長く残すほどCSRFトークンとしての価値が下がる */
export const OAUTH_STATE_MAX_AGE_SEC = 600;
