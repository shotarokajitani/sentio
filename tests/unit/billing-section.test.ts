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

describe("BU-1-4 active でない status は、すべて試用中として扱う", () => {
  // Stripe が返しうる status のうち、**枠を与えないもの**（`lib/billing/plan.ts` の外側）。
  // 支払いが止まった会社が**自分で再開できる**ことが要る
  const NOT_ACTIVE = ["canceled", "past_due", "incomplete", "unpaid", "", "ACTIVE"];

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
