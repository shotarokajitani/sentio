/**
 * 特定商取引法に基づく表記（`/legal`）と、申込前の最終確認（2026-09-09 検収者）。
 *
 * 固定するのは3つ。
 *
 *   1. **窓口のアドレスが無ければページを出さない**（fail-closed）。
 *      届かないアドレスを法定の表記に載せない
 *   2. 金額と無料期間は**定数から**出る（画面に数字を書かない）
 *   3. **確認画面と表記が同じ文字列である。** 法定の最終確認画面は
 *      「表示した内容で申し込ませる」ための面なので、表記と食い違ってはならない
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LegalPage from "@/app/legal/page";
import { ConnectClient } from "@/app/connect/connect-client";
import type { ConnectionOverview } from "@/lib/connections/overview";
import { ja } from "@/i18n/ja";
import { SENTIO_PRICE_JPY_TAX_INCLUDED, SENTIO_TRIAL_DAYS } from "@/lib/pricing";

const SUPPORT_EMAIL = "nobody@example.invalid";

const EMPTY_OVERVIEW: ConnectionOverview = {
  connections: [],
  counts: { google_calendar: 0, "csv:accounting": 0, freee: 0 },
};

function renderLegal(): string {
  return renderToStaticMarkup(createElement(LegalPage));
}

function renderConnect(subscriptionStatus: string | null): string {
  return renderToStaticMarkup(
    createElement(ConnectClient, {
      failureMessage: null,
      initialOverview: EMPTY_OVERVIEW,
      accountEmail: SUPPORT_EMAIL,
      siteUrl: null,
      subscriptionStatus,
    }),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("窓口が未設定なら /legal を出さない（fail-closed）", () => {
  it("未設定のときは 404 になる", () => {
    vi.stubEnv("SENTIO_SUPPORT_EMAIL", "");

    // `notFound()` は例外で 404 を起こす。**描画されないことが要件である**
    expect(() => renderLegal()).toThrow();
  });

  it("空白だけでも 404 になる（見た目が入っている値に騙されない）", () => {
    vi.stubEnv("SENTIO_SUPPORT_EMAIL", "   ");

    expect(() => renderLegal()).toThrow();
  });
});

describe("窓口が設定されていれば表記を出す", () => {
  it("設定されたアドレスをそのまま出す（別の場所に持たない）", () => {
    vi.stubEnv("SENTIO_SUPPORT_EMAIL", SUPPORT_EMAIL);

    expect(renderLegal()).toContain(SUPPORT_EMAIL);
  });

  it("金額と無料期間は定数から出る", () => {
    vi.stubEnv("SENTIO_SUPPORT_EMAIL", SUPPORT_EMAIL);
    const html = renderLegal();

    expect(html).toContain(ja.legalNotice.price(SENTIO_PRICE_JPY_TAX_INCLUDED));
    expect(html).toContain(ja.legalNotice.priceTrial(SENTIO_TRIAL_DAYS));
    expect(html).toContain(ja.legalNotice.paymentTiming(SENTIO_TRIAL_DAYS));
  });

  it("法定の項目が落ちていない", () => {
    vi.stubEnv("SENTIO_SUPPORT_EMAIL", SUPPORT_EMAIL);
    const html = renderLegal();

    for (const label of [
      ja.legalNotice.sellerLabel,
      ja.legalNotice.representativeLabel,
      ja.legalNotice.addressLabel,
      ja.legalNotice.phoneLabel,
      ja.legalNotice.emailLabel,
      ja.legalNotice.priceLabel,
      ja.legalNotice.extraCostLabel,
      ja.legalNotice.paymentMethodLabel,
      ja.legalNotice.paymentTimingLabel,
      ja.legalNotice.contentLabel,
      ja.legalNotice.deliveryLabel,
      ja.legalNotice.applicationPeriodLabel,
      ja.legalNotice.cancelLabel,
      ja.legalNotice.refundLabel,
      ja.legalNotice.environmentLabel,
    ]) {
      expect(html, label).toContain(label);
    }
  });

  it("解約の説明がポータルの挙動（期間の終了日まで使える）と一致している", () => {
    vi.stubEnv("SENTIO_SUPPORT_EMAIL", SUPPORT_EMAIL);

    expect(renderLegal()).toContain(ja.legalNotice.cancel3);
    // **日割り返金はしない**という決定と対になる一文
    expect(renderLegal()).toContain(ja.legalNotice.refund2);
  });

  it("分割払いに対応しないと書いてある（一回払いの商品を作らない決定と対）", () => {
    vi.stubEnv("SENTIO_SUPPORT_EMAIL", SUPPORT_EMAIL);

    expect(renderLegal()).toContain(ja.legalNotice.paymentMethod3);
  });
});

describe("申込前の確認画面は、表記と同じ文字列を出す", () => {
  it("6項目が申込前に出る", () => {
    const html = renderConnect(null);

    for (const text of [
      ja.legalNotice.content1,
      ja.legalNotice.price(SENTIO_PRICE_JPY_TAX_INCLUDED),
      ja.legalNotice.paymentTiming(SENTIO_TRIAL_DAYS),
      ja.legalNotice.paymentMethod1,
      ja.legalNotice.delivery,
      ja.legalNotice.applicationPeriod,
      ja.legalNotice.cancel1,
    ]) {
      expect(html, text).toContain(text);
    }
  });

  it("表記と確認画面が同じ文字列である（別の言い方をしない）", () => {
    vi.stubEnv("SENTIO_SUPPORT_EMAIL", SUPPORT_EMAIL);
    const legal = renderLegal();
    const connect = renderConnect(null);

    for (const text of [
      ja.legalNotice.content2,
      ja.legalNotice.priceTrialNote,
      ja.legalNotice.paymentTimingNote,
      ja.legalNotice.cancel3,
    ]) {
      expect(legal, text).toContain(text);
      expect(connect, text).toContain(text);
    }
  });

  it("**陰性**: 購読している人には確認を出さない（申し込む面ではない）", () => {
    const html = renderConnect("active");

    expect(html).not.toContain(ja.checkoutNotice.title);
    expect(html).not.toContain(ja.legalNotice.applicationPeriod);
  });

  it("**陰性**: 窓口が未設定なら、確認画面から /legal へのリンクを出さない", () => {
    // 既定は false。**404 へのリンクを残さない**
    expect(renderConnect(null)).not.toContain('href="/legal"');
  });
});
