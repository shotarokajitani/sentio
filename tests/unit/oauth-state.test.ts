import { describe, it, expect } from "vitest";
import { createOAuthState, oauthStateCookieName, isMatchingState } from "@/lib/auth/oauth-state";

describe("A-2-4 OAuth state のCSRFトークン化", () => {
  it("stateは毎回異なる乱数である", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(createOAuthState());

    expect(seen.size).toBe(100);
  });

  it("stateは推測に耐える長さを持つ（32バイト由来）", () => {
    // base64url の 32バイトは43文字
    expect(createOAuthState()).toHaveLength(43);
  });

  it("stateがUUID形式でない＝company_idを流用していない", () => {
    const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    expect(createOAuthState()).not.toMatch(uuidLike);
  });

  it("cookie名はプロバイダごとに分かれる", () => {
    expect(oauthStateCookieName("google")).not.toBe(oauthStateCookieName("freee"));
  });

  it("一致する場合のみ true", () => {
    const state = createOAuthState();

    expect(isMatchingState(state, state)).toBe(true);
  });

  it("不一致・欠落・長さ違いはすべて false", () => {
    const state = createOAuthState();

    expect(isMatchingState(state, createOAuthState())).toBe(false);
    expect(isMatchingState(state, null)).toBe(false);
    expect(isMatchingState(null, state)).toBe(false);
    expect(isMatchingState(null, null)).toBe(false);
    expect(isMatchingState(state, state.slice(0, -1))).toBe(false);
    expect(isMatchingState("", "")).toBe(false);
  });
});
