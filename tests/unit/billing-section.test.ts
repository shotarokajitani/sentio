/**
 * `/connect` の「プラン」の節（契約 `docs/contracts/slice-billing-ui.md`・BU-1 系）。
 *
 * **状態の正本は `auth.users.user_metadata.subscription.status` だけ**（BU-D2）。
 * Webhook が書いている場所であり、画面から Stripe API は叩かない。
 *
 * ここは**描画結果の文字列**を直接見る（`report-view.test.ts` / `connect-timezone.test.ts`
 * と同じ形）。出る・出ないの両方を固定するのが目的で、**陰性コントロールが主役**である。
 * 購読中の人に「標準プランにする」を見せるのは、二重課金への入口をこちらから開くことになる。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectClient } from "@/app/connect/connect-client";
import type { ConnectionOverview } from "@/lib/connections/overview";
import { ja } from "@/i18n/ja";

// 実在しないアドレスに固定する（契約 停止点。実在の値をフィクスチャに書かない）
const FAKE_ACCOUNT_EMAIL = "nobody@example.invalid";

const EMPTY_OVERVIEW: ConnectionOverview = {
  connections: [],
  counts: { google_calendar: 0, "csv:accounting": 0, freee: 0 },
};

function render(subscriptionStatus: string | null): string {
  return renderToStaticMarkup(
    createElement(ConnectClient, {
      failureMessage: null,
      initialOverview: EMPTY_OVERVIEW,
      accountEmail: FAKE_ACCOUNT_EMAIL,
      siteUrl: null,
      subscriptionStatus,
    }),
  );
}

describe("BU-1-1 / BU-1-3 試用中の見せ方", () => {
  it("status が無いとき、「試用中」と購読ボタンを出す", () => {
    const html = render(null);

    expect(html).toContain(ja.billing.sectionTitle);
    expect(html).toContain(ja.billing.trialState);
    expect(html).toContain(ja.billing.subscribe);
  });

  it("BU-1-3 陰性コントロール: 試用中に「購読中」を出さない", () => {
    expect(render(null)).not.toContain(ja.billing.subscribedState);
  });

  it("金額を出す。**税込であること**まで含めて出す（BU-D6）", () => {
    expect(render(null)).toContain(ja.billing.standardPrice);
    // 09_pricing.md の決定は「税込」である。額だけ出すと意味が変わる
    expect(ja.billing.standardPrice).toContain("税込");
  });
});

describe("④-b 解約導線（2026-09-08・BU-D4 を改めた）", () => {
  /**
   * **Stripe 側に購読がある状態**（2026-09-08 決定）。行き先はポータルである。
   *
   * `past_due` をここに入れたのは、支払いが止まった会社の行き先が
   * **「支払い方法の更新」であって、新規購読の作成ではない**ため。
   * 購読ボタンを出すと、`customer` を渡していない checkout が
   * **2本目の購読を作る**（`api/billing/checkout` は 409 で止める）。
   */
  const HAS_SUBSCRIPTION = ["active", "past_due", "trialing"];

  it("購読中には管理の入口と、**解約もここでできる**という1行を出す", () => {
    const html = render("active");

    expect(html).toContain(ja.billing.managePlan);
    // ボタンの文言だけでは「解約はここ」と分からない。**導線として機能しない**
    expect(html).toContain(ja.billing.manageNote);
  });

  it.each(HAS_SUBSCRIPTION)("status=%s では管理の入口を出す（購読ボタンを出さない）", (status) => {
    const html = render(status);

    expect(html).toContain(ja.billing.managePlan);
    // **二重課金の入口をこちらから開かない。** サーバ側も 409 で止める（二重の関門）
    expect(html).not.toContain(ja.billing.subscribe);
  });

  it("past_due は**支払い方法の更新**へ寄せる（解約の1行に差し替えない）", () => {
    const html = render("past_due");

    expect(html).toContain(ja.billing.paymentIssueState);
    expect(html).toContain(ja.billing.paymentNote);
    // 払えていない状態を「購読中」と読ませない。**直す場所がある**ことを出す
    expect(html).not.toContain(ja.billing.subscribedState);
    expect(html).not.toContain(ja.billing.manageNote);
  });

  it("**陰性コントロール**: 購読が無いときは管理の入口を出さない（押して 404 を見せない）", () => {
    // `canceled` は購読が終わっている。**新しく始めるのが正しい**（BU-1-4）
    for (const status of [null, "canceled", "incomplete", "unpaid", "", "ACTIVE"]) {
      const html = render(status);

      expect(html, `status=${status}`).not.toContain(ja.billing.managePlan);
      expect(html, `status=${status}`).not.toContain(ja.billing.manageNote);
      expect(html, `status=${status}`).not.toContain(ja.billing.paymentNote);
    }
  });

  it("**陰性コントロール**: 解約という語を主操作の文言にしない（できるのは解約だけではない）", () => {
    expect(ja.billing.managePlan).not.toContain("解約");
    // ただし補足の1行では明示する。**分からなければ導線として機能しない**
    expect(ja.billing.manageNote).toContain("解約");
  });
});

describe("BU-1-2 購読中の見せ方（陰性コントロール）", () => {
  it("status === active のとき「標準プラン・購読中」を出す", () => {
    expect(render("active")).toContain(ja.billing.subscribedState);
  });

  it("**購読ボタンを出さない。** 二重課金への入口をこちらから開かない", () => {
    const html = render("active");

    expect(html).not.toContain(ja.billing.subscribe);
    // 手続き中の文言も、失敗の文言も出る余地が無い
    expect(html).not.toContain(ja.billing.starting);
    expect(html).not.toContain(ja.billing.startFailed);
  });

  it("購読中に「試用中」を出さない", () => {
    expect(render("active")).not.toContain(ja.billing.trialState);
  });
});

describe("BU-1-4 購読が無い status は、すべて試用中として扱う", () => {
  /**
   * Stripe が返しうる status のうち、**枠を与えないもの**（`lib/billing/plan.ts` の外側）で、
   * かつ**購読が Stripe 側に残っていない**もの。ここは新しく始めるのが正しい。
   *
   * **`past_due` は 2026-09-08 にここから外した**（ポータル側へ寄せた）。
   * `unpaid` は残してある——扱いは未判断で `docs/spec/07_open_items.md` に登録した。
   */
  const NOT_ACTIVE = ["canceled", "incomplete", "unpaid", "", "ACTIVE"];

  it.each(NOT_ACTIVE)("status=%s のとき購読ボタンを出す", (status) => {
    const html = render(status);

    expect(html).toContain(ja.billing.subscribe);
    expect(html).not.toContain(ja.billing.subscribedState);
  });
});

describe("BU-D6 停止点: 金額をコードに直書きしない", () => {
  it("画面のソースに金額の数字が現れない（正本は i18n だけ）", () => {
    const source = readFileSync("src/app/connect/connect-client.tsx", "utf8");

    for (const literal of ["3万円", "30,000", "30000", "月額"]) {
      expect(source, literal).not.toContain(literal);
    }
  });
});
