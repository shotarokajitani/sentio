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
   * 判定は**否定リスト**（`lib/billing/subscription-state.ts`）で、
   * Stripe の8状態のうち**購読が存在しないのは `canceled` と `incomplete_expired` の2つだけ**。
   * 残りで購読ボタンを出すと、`customer` を渡していない checkout が
   * **2本目の購読を作る**（`api/billing/checkout` は 409 で止める。二重の関門）。
   *
   * **知らない状態も既定でこちら側**である。列挙式に戻すと素通りする。
   */
  const HAS_SUBSCRIPTION = [
    "active",
    "past_due",
    "trialing",
    "unpaid",
    "incomplete",
    "paused",
    "ACTIVE",
    "status_stripe_has_not_shipped_yet",
  ];

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

  // `unpaid` は `past_due` の再試行が尽きた後で、**直す場所は同じ**（2026-09-08 決定）
  it.each(["past_due", "unpaid"])(
    "%s は**支払い方法の更新**へ寄せる（解約の1行に差し替えない）",
    (status) => {
      const html = render(status);

      expect(html).toContain(ja.billing.paymentIssueState);
      expect(html).toContain(ja.billing.paymentNote);
      // 払えていない状態を「購読中」と読ませない。**直す場所がある**ことを出す
      expect(html).not.toContain(ja.billing.subscribedState);
      expect(html).not.toContain(ja.billing.manageNote);
    },
  );

  it("**陰性コントロール**: 購読が無いときは管理の入口を出さない（押して 404 を見せない）", () => {
    // 購読が存在しない2つと、記録が無いとき。**ここでポータルを出すと 404 を見せる**
    for (const status of [null, "", "canceled", "incomplete_expired"]) {
      const html = render(status);

      expect(html, `status=${status}`).not.toContain(ja.billing.managePlan);
      expect(html, `status=${status}`).not.toContain(ja.billing.manageNote);
      expect(html, `status=${status}`).not.toContain(ja.billing.paymentNote);
    }
  });

  it("incomplete は**支払いの手続きが終わっていない**ことを出す（試用中に落とさない）", () => {
    const html = render("incomplete");

    expect(html).toContain(ja.billing.incompleteState);
    // 支払い方法の1行は出す。**解約の1行は出さない**
    expect(html).toContain(ja.billing.paymentNote);
    expect(html).not.toContain(ja.billing.manageNote);
    expect(html).not.toContain(ja.billing.trialState);
  });

  it("paused は一時停止中とだけ出す（**補足は付けない**）", () => {
    const html = render("paused");

    expect(html).toContain(ja.billing.pausedState);
    expect(html).not.toContain(ja.billing.manageNote);
    expect(html).not.toContain(ja.billing.paymentNote);
    expect(html).not.toContain(ja.billing.trialState);
  });

  it.each(["active", "trialing"])("%s は解約の1行を出す", (status) => {
    const html = render(status);

    expect(html).toContain(ja.billing.manageNote);
    expect(html).not.toContain(ja.billing.paymentNote);
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

describe("BU-1-4 購読が存在しない status だけ、試用中として扱う", () => {
  /**
   * **2026-09-08 に否定リストへ変えた。** 元は「`active` でなければ全部試用中」だったが、
   * その形だと `past_due` / `unpaid` / `incomplete` / `paused` に購読ボタンが出て、
   * 押せば2本目の購読ができる。
   *
   * ここに残るのは**購読が Stripe 側に存在しない2つ**と、**記録が無いとき**だけである。
   */
  const NOT_ACTIVE = ["canceled", "incomplete_expired", ""];

  it.each(NOT_ACTIVE)("status=%s のとき購読ボタンを出す", (status) => {
    const html = render(status);

    expect(html).toContain(ja.billing.subscribe);
    expect(html).not.toContain(ja.billing.subscribedState);
  });
});

describe("**陰性コントロール**: 知らない状態を既知として見せない（2026-09-08 決定）", () => {
  /**
   * 知らない状態を「試用中」に落とすのは、**知らないものを既知として表示する**ことである。
   * 関門を列挙式にしていたのと同じ誤りなので、文言にも同じ発想を通す。
   *
   * **列挙で埋める形に戻すと、ここが赤くなる。**
   */
  const UNKNOWN = ["ACTIVE", "grace_period", "status_stripe_has_not_shipped_yet"];

  it.each(UNKNOWN)("status=%s では「試用中」と表示しない", (status) => {
    const html = render(status);

    expect(html).not.toContain(ja.billing.trialState);
    expect(html).not.toContain(ja.billing.subscribedState);
    expect(html).not.toContain(ja.billing.paymentIssueState);
    expect(html).not.toContain(ja.billing.incompleteState);
    expect(html).not.toContain(ja.billing.pausedState);
  });

  it.each(UNKNOWN)("status=%s では解約も支払いも補足しない", (status) => {
    const html = render(status);

    // 中立の表示だけを出す。**できるかどうかを確かめていないことを、できると書かない**
    expect(html).toContain(ja.billing.unknownState);
    expect(html).not.toContain(ja.billing.manageNote);
    expect(html).not.toContain(ja.billing.paymentNote);
  });

  it("中立の表示に情緒的な語を入れない", () => {
    for (const word of ["申し訳", "ご迷惑", "恐れ入り", "残念", "！"]) {
      expect(ja.billing.unknownState, word).not.toContain(word);
    }
    // それでも**購読ボタンは出さない**（押せば2本目の購読ができる）
    expect(render("grace_period")).not.toContain(ja.billing.subscribe);
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
