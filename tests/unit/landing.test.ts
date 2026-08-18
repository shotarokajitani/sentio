import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LandingPage from "@/app/page";
import { ja } from "@/i18n/ja";

/**
 * トップページの存在そのものが要件（Google審査は「ホームページに
 * プライバシーポリシーへのリンク」を要求する）。
 * リンクは消しても画面は壊れないため、人間のレビューでは落ちやすい。
 * 審査に落ちる形の欠落をここで機械的に止める。
 */
function render(): string {
  return renderToStaticMarkup(createElement(LandingPage));
}

describe("トップページ", () => {
  it("プライバシーポリシーへのリンクがある（Google審査の要件）", () => {
    expect(render()).toContain('href="/privacy"');
  });

  it("利用規約へのリンクがある", () => {
    expect(render()).toContain('href="/terms"');
  });

  it("ログインへの導線がある", () => {
    expect(render()).toContain('href="/login"');
  });

  it("見出しと説明が辞書経由で出る", () => {
    const html = render();
    expect(html).toContain(ja.landing.title);
    expect(html).toContain(ja.landing.lead);
  });

  it("ワードマークが出る", () => {
    expect(render()).toContain("wordmark");
  });
});
