/**
 * トップページ（2026-09-09 に7ブロックへ差し替え。検収者の承認済み文言）。
 *
 * トップの存在そのものが要件（Google審査は「ホームページに
 * プライバシーポリシーへのリンク」を要求する）。
 * リンクは消しても画面は壊れないため、人間のレビューでは落ちやすい。
 * 審査に落ちる形の欠落をここで機械的に止める。
 *
 * **2026-08-19 に審査で指摘された「ホームページでアプリの目的が説明されていない」への
 * 備えとして置いていた「Sentio について」の節は、この差し替えで無くなった。**
 * 見出しに平文のアプリ名を置く試験も、対応する見出しが無くなったので外した。
 * 残っているのは `<title>` だけである（`app/layout.tsx` の metadata）。
 * **この判断の是非は `docs/spec/07_open_items.md` に登録してある。**
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import LandingPage from "@/app/page";
import { ja } from "@/i18n/ja";
import { SENTIO_PRICE_JPY_TAX_INCLUDED, SENTIO_TRIAL_DAYS } from "@/lib/pricing";

function render(): string {
  return renderToStaticMarkup(createElement(LandingPage));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("審査の要件", () => {
  it("プライバシーポリシーへのリンクがある（Google審査の要件）", () => {
    expect(render()).toContain('href="/privacy"');
  });

  it("利用規約へのリンクがある", () => {
    expect(render()).toContain('href="/terms"');
  });

  it("ログインへの導線がある", () => {
    expect(render()).toContain('href="/login"');
  });

  it("ワードマークが出る", () => {
    expect(render()).toContain("wordmark");
  });

  // 見出しの平文アプリ名が無くなったので、機械可読なアプリ名はここだけになった。
  // `app/layout.tsx` は `next/font` を読むため試験からは import できない。ソースで見る
  it("ページの題にアプリ名が入る（審査の自動検証が見る位置のひとつ）", () => {
    const layout = readFileSync(path.resolve(__dirname, "../../src/app/layout.tsx"), "utf8");

    expect(layout).toContain(`title: "${ja.brand}"`);
  });
});

describe("7ブロックが出る", () => {
  const html = render();

  it("ブロック1: 見出しと2行、接続の導線", () => {
    expect(html).toContain(ja.landing.title);
    expect(html).toContain(ja.landing.lead);
    expect(html).toContain(ja.landing.lead2);
    expect(html).toContain(ja.landing.start);
    expect(html).toContain(ja.landing.startTrial(SENTIO_TRIAL_DAYS));
  });

  it("ブロック2: いま届くもの（4項目）", () => {
    expect(html).toContain(ja.landing.nowTitle);
    for (const item of ja.landing.now) {
      expect(html, item.title).toContain(item.title);
      expect(html, item.body).toContain(item.body);
    }
  });

  it("ブロック3: **いまできないこと**（3項目。同じ大きさで出す）", () => {
    expect(html).toContain(ja.landing.notYetTitle);
    for (const item of ja.landing.notYet) {
      expect(html, item.title).toContain(item.title);
      expect(html, item.body).toContain(item.body);
    }
  });

  it("ブロック4: 始め方（3手順）", () => {
    expect(html).toContain(ja.landing.stepsTitle);
    for (const step of ja.landing.steps) expect(html, step).toContain(step);
  });

  it("ブロック5: 料金は定数から出る", () => {
    expect(html).toContain(ja.landing.priceTitle);
    expect(html).toContain(ja.landing.priceAmount(SENTIO_PRICE_JPY_TAX_INCLUDED));
    expect(html).toContain(ja.landing.priceTrial(SENTIO_TRIAL_DAYS));
    expect(html).toContain(ja.landing.priceTrialNote);
  });

  it("ブロック6: よくある質問（3問）", () => {
    expect(html).toContain(ja.landing.faqTitle);
    for (const item of ja.landing.faq) {
      expect(html, item.q).toContain(item.q);
      expect(html, item.a).toContain(item.a);
    }
  });

  it("ブロック7: 事業者名と所在地", () => {
    expect(html).toContain(ja.landing.company);
    expect(html).toContain(ja.landing.companyAddress);
  });
});

describe("書き方の原則（2026-09-09 の4点）", () => {
  const html = render();

  it("「会計データを接続」と書かない（繋がっているのは Googleカレンダーだけ）", () => {
    expect(html).not.toContain("会計データを接続");
  });

  it("「など」を使わない", () => {
    expect(html).not.toContain("など");
  });

  it("数字を出すときは「実測では」を前に置く", () => {
    // 実測でない数字を製品の説明に混ぜない。中央値を出すなら出所を明示する
    if (html.includes("中央値")) expect(html).toContain("実測では");
  });

  it("**陰性**: 変化の自動検出を、動いているものとして書かない", () => {
    // 本番の findings は0行である。**主語にしない**
    expect(html).toContain("変化の自動検出は、まだ動いていません");
  });
});

describe("特商法の表記へのリンクは、窓口が設定されているときだけ", () => {
  it("未設定なら出さない（404 へのリンクを残さない）", () => {
    vi.stubEnv("SENTIO_SUPPORT_EMAIL", "");

    expect(render()).not.toContain('href="/legal"');
  });

  it("設定されていれば出す", () => {
    vi.stubEnv("SENTIO_SUPPORT_EMAIL", "nobody@example.invalid");

    const html = render();
    expect(html).toContain('href="/legal"');
    expect(html).toContain(ja.legal.noticeTitle);
  });
});
