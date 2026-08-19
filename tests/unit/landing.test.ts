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
    expect(html).toContain(ja.landing.lead2);
    expect(html).toContain(ja.landing.start);
  });

  // 検収で「登録画面と語彙を統一する」と決めた。
  // 片方だけ直すと画面をまたいで言い方がずれるが、単体では誰も気づけない
  it("2文目は登録画面と同一文言（語彙統一）", () => {
    expect(ja.landing.lead2).toBe(ja.register.lead2);
  });

  it("ワードマークが出る", () => {
    expect(render()).toContain("wordmark");
  });

  // Google の OAuth ブランディング審査に「ホームページでアプリの目的が説明されていない」と
  // 指摘された。lead は情緒的な導入で、何をするサービスかの事実記述が無かった。
  // 情緒の文とは別に、事実の段落を必ず置く
  it("サービスの事実説明が出る", () => {
    const html = render();
    expect(html).toContain(ja.landing.aboutTitle);
    expect(html).toContain(ja.landing.about);
    expect(html).toContain(ja.landing.about2);
  });

  // 同じ審査で「同意画面のアプリ名がホームページに無い」とも指摘された。
  // 題字は e の着色のため <span> に割れていて、レンダリング後HTMLに
  // 連続した "Sentio" が現れない。見出し要素に平文で置いて機械可読にする
  it("見出しに平文のアプリ名が入る（審査の自動検証が見る位置）", () => {
    const heading = render().match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    expect(heading?.[1]).toContain(ja.brand);
  });
});
