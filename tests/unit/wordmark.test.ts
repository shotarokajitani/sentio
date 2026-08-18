import { describe, it, expect } from "vitest";
import { WORDMARK_SEGMENTS } from "@/components/Masthead";
import { ja } from "@/i18n/ja";

/**
 * ワードマークは表示上「S / e / ntio」に割って e だけをアクセント色にする。
 * 分割はあくまで描画の都合であって、読み取れる文字列はブランド名そのものでなければならない。
 * 1文字を落とす・重複させる編集は目視では気づきにくいので、ここで機械的に留める。
 */
describe("ワードマークの分割", () => {
  it("連結するとブランド名に一致する", () => {
    expect(WORDMARK_SEGMENTS.map((s) => s.text).join("")).toBe(ja.brand);
  });

  it("アクセント色が付くのは e ちょうど1つ", () => {
    const accented = WORDMARK_SEGMENTS.filter((s) => s.accent);
    expect(accented).toHaveLength(1);
    expect(accented[0].text).toBe("e");
  });

  it("アクセント以外の文字は地の色のまま", () => {
    const plain = WORDMARK_SEGMENTS.filter((s) => !s.accent).map((s) => s.text);
    expect(plain).toEqual(["S", "ntio"]);
  });
});
