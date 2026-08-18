import { describe, it, expect } from "vitest";
import { errorMessage } from "@/i18n";
import { ja } from "@/i18n/ja";

describe("A-3-2 内部コードを画面に出さない", () => {
  it("既知のキーは辞書の文言になる", () => {
    expect(errorMessage("invalid_credentials")).toBe(ja.errors.invalid_credentials);
  });

  it("未知のキーは汎用文言に落ちる（生の値を通さない）", () => {
    const raw = "RLS_VIOLATION";

    expect(errorMessage(raw)).toBe(ja.errors.unknown);
    expect(errorMessage(raw)).not.toContain(raw);
  });

  it("辞書のプロトタイプ由来のキーを拾わない", () => {
    expect(errorMessage("toString")).toBe(ja.errors.unknown);
    expect(errorMessage("constructor")).toBe(ja.errors.unknown);
  });

  it("未指定なら何も表示しない", () => {
    expect(errorMessage(null)).toBeNull();
    expect(errorMessage(undefined)).toBeNull();
    expect(errorMessage("")).toBeNull();
  });

  it("どの文言も内部コードらしい大文字スネークケースを含まない", () => {
    for (const message of Object.values(ja.errors)) {
      expect(message).not.toMatch(/[A-Z_]{4,}/);
    }
  });
});
