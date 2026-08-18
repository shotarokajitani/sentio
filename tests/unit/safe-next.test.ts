import { describe, it, expect } from "vitest";
import { safeNext, DEFAULT_NEXT } from "@/lib/auth/safe-next";

describe("ログイン後の戻り先はオープンリダイレクトにならない", () => {
  it("自サイト内のパスはそのまま通す", () => {
    expect(safeNext("/connect")).toBe("/connect");
    expect(safeNext("/register/complete?events=3")).toBe("/register/complete?events=3");
  });

  it("外部URLは既定値に落とす", () => {
    expect(safeNext("https://evil.example")).toBe(DEFAULT_NEXT);
    expect(safeNext("http://evil.example")).toBe(DEFAULT_NEXT);
  });

  it("プロトコル相対とバックスラッシュ表記も外部扱いにする", () => {
    expect(safeNext("//evil.example")).toBe(DEFAULT_NEXT);
    expect(safeNext(String.raw`/\evil.example`)).toBe(DEFAULT_NEXT);
  });

  it("文字列でない値・空文字は既定値", () => {
    expect(safeNext(null)).toBe(DEFAULT_NEXT);
    expect(safeNext(undefined)).toBe(DEFAULT_NEXT);
    expect(safeNext("")).toBe(DEFAULT_NEXT);
    expect(safeNext(["/connect"])).toBe(DEFAULT_NEXT);
  });
});
