import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isTokenExpired,
  EXPIRY_BUFFER_MS,
  PROVIDER_CONFIG,
} from "@edge/_shared/token-refresh";

describe("EXPIRY_BUFFER_MS", () => {
  it("should be 5 minutes in milliseconds", () => {
    expect(EXPIRY_BUFFER_MS).toBe(5 * 60 * 1000);
  });
});

describe("PROVIDER_CONFIG", () => {
  it("google_calendar config has correct tokenUrl and env vars", () => {
    const gc = PROVIDER_CONFIG.google_calendar;
    expect(gc).toBeDefined();
    expect(gc.tokenUrl).toBe("https://oauth2.googleapis.com/token");
    expect(gc.clientIdEnv).toBe("GOOGLE_CLIENT_ID");
    expect(gc.clientSecretEnv).toBe("GOOGLE_CLIENT_SECRET");
  });

  it("freee config has correct tokenUrl and env vars", () => {
    const freee = PROVIDER_CONFIG.freee;
    expect(freee).toBeDefined();
    expect(freee.tokenUrl).toBe(
      "https://accounts.secure.freee.co.jp/public_api/token",
    );
    expect(freee.clientIdEnv).toBe("FREEE_CLIENT_ID");
    expect(freee.clientSecretEnv).toBe("FREEE_CLIENT_SECRET");
  });
});

describe("isTokenExpired", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 固定時刻: 2026-01-01T00:00:00Z
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true when expiresAt is null", () => {
    expect(isTokenExpired(null)).toBe(true);
  });

  it("returns true when token already expired (past date)", () => {
    expect(isTokenExpired("2025-12-31T23:00:00Z")).toBe(true);
  });

  it("returns true when token expires within buffer (4 min future)", () => {
    // 4分後 = バッファ(5分)以内なので期限切れ扱い
    const fourMinFuture = new Date(
      Date.now() + 4 * 60 * 1000,
    ).toISOString();
    expect(isTokenExpired(fourMinFuture)).toBe(true);
  });

  it("returns false when token expires well beyond buffer (10 min future)", () => {
    const tenMinFuture = new Date(
      Date.now() + 10 * 60 * 1000,
    ).toISOString();
    expect(isTokenExpired(tenMinFuture)).toBe(false);
  });

  it("returns true when token expires exactly at buffer boundary", () => {
    // ちょうど5分後 = Date.now() + EXPIRY_BUFFER_MS >= expiryTime → true
    const exactBuffer = new Date(
      Date.now() + EXPIRY_BUFFER_MS,
    ).toISOString();
    expect(isTokenExpired(exactBuffer)).toBe(true);
  });
});
