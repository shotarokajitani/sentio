/**
 * 無料期間の終わりの知らせ（発注 A-7）。
 *
 * **お金の話は黙って始めない。** 終了日・金額・やめ方の3つが揃わなければ送らない。
 * `reconnect-notice` と同じ形で、**差し込みが欠けたら組み立てない**（fail-closed）。
 */
import { describe, it, expect } from "vitest";
import { formatTrialEndDate, renderTrialEndingNotice } from "@/lib/billing/trial-ending";
import { SENTIO_PRICE_JPY_TAX_INCLUDED } from "@/lib/pricing";
import { ja } from "@/i18n/ja";

/** 2026-09-23 09:00 JST（UNIX 秒） */
const TRIAL_END = Math.floor(Date.parse("2026-09-23T00:00:00.000Z") / 1000);
const MANAGE_URL = "https://example.invalid/connect";

describe("差し込みが欠けたら送らない", () => {
  it("終了日が無ければ組み立てない", () => {
    expect(renderTrialEndingNotice({ trialEndUnix: null, manageUrl: MANAGE_URL })).toBeNull();
  });

  it("行き先が無ければ組み立てない", () => {
    expect(renderTrialEndingNotice({ trialEndUnix: TRIAL_END, manageUrl: "" })).toBeNull();
    expect(renderTrialEndingNotice({ trialEndUnix: TRIAL_END, manageUrl: "   " })).toBeNull();
  });
});

describe("揃っていれば、3つを本文に出す", () => {
  const notice = renderTrialEndingNotice({ trialEndUnix: TRIAL_END, manageUrl: MANAGE_URL })!;

  it("終了日（JST の日付）", () => {
    expect(formatTrialEndDate(TRIAL_END)).toBe("2026年9月23日");
    expect(notice.subject).toContain("2026年9月23日");
    expect(notice.body).toContain("2026年9月23日");
  });

  it("金額（税込・定数から）", () => {
    expect(notice.body).toContain(ja.trialEnding.amount(SENTIO_PRICE_JPY_TAX_INCLUDED));
    expect(notice.body).toContain("税込");
  });

  it("やめ方（行き先つき）", () => {
    expect(notice.body).toContain(MANAGE_URL);
    expect(notice.body).toContain("解約");
  });

  it("**陰性**: 「自動的に課金されます」のような脅しを書かない", () => {
    for (const word of ["自動的に課金", "ご注意ください", "必ず", "！"]) {
      expect(notice.body, word).not.toContain(word);
    }
  });

  it("**陰性**: 内部語を本文に出さない", () => {
    for (const word of ["subscription", "trial_will_end", "Stripe", "webhook"]) {
      expect(notice.body, word).not.toContain(word);
    }
  });
});
