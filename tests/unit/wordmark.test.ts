import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Masthead, WORDMARK_SEGMENTS } from "@/components/Masthead";
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

/**
 * 分割は人間の目には1語に見えるが、機械には見えない。
 * Google の OAuth ブランディング審査は題字要素のテキストを走査して
 * 「同意画面のアプリ名がホームページに無い」と判定した（2026-08-19 指摘）。
 * 分割を保ったまま、属性で平文のブランド名を与えることで機械可読にする。
 */
describe("題字の機械可読性", () => {
  it("ワードマークの外側要素が平文のブランド名を属性で持つ", () => {
    const html = renderToStaticMarkup(createElement(Masthead));
    const tag = html.match(/<span class="wordmark"[^>]*>/)?.[0] ?? "";

    expect(tag).toContain(`aria-label="${ja.brand}"`);
    expect(tag).toContain(`title="${ja.brand}"`);
  });
});
