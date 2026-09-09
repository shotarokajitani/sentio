/**
 * 無料期間の終わりを知らせる（発注 A-7・Stripe の `customer.subscription.trial_will_end`）。
 *
 * **お金の話は黙って始めない。** 無料期間が終われば課金が始まる。
 * その事実を、終了日・金額・やめ方の3つとセットで、始まる前に1通出す。
 *
 * 文面の組み立ては**ここ1箇所**に置く（`_shared/reconnect-notice.ts` と同じ作法）。
 * **差し込みが1つでも欠けたら組み立てない。** 欠けたまま送ると
 * 「（不明）に終了します」のような文面が顧客に届く。
 */

import { ja } from "@/i18n/ja";
import { SENTIO_PRICE_JPY_TAX_INCLUDED } from "@/lib/pricing";

export interface TrialEndingInput {
  /** 無料期間の終了時刻（UNIX 秒）。Stripe の `subscription.trial_end` */
  trialEndUnix: number | null;
  /** 「プランと支払いを管理」へ行ける画面の URL */
  manageUrl: string;
}

export interface TrialEndingNotice {
  subject: string;
  body: string;
}

/** JST の「2026年9月23日」。**受け手は日本にいる**（`reconnect-notice` と同じ扱い） */
export function formatTrialEndDate(unixSeconds: number): string | null {
  const at = new Date(unixSeconds * 1000);
  if (Number.isNaN(at.getTime())) return null;

  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).formatToParts(at);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  // `ja-JP` は「月」を literal として別に返す。**部品を連結するときに単位を落とさない**
  return `${get("year")}年${get("month")}月${get("day")}日`;
}

/**
 * 文面を組み立てる。**差し込みが1つでも欠けたら `null` を返す。**
 * 返さないことで、呼び出し側は送信に入れない（fail-closed）。
 */
export function renderTrialEndingNotice(input: TrialEndingInput): TrialEndingNotice | null {
  const manageUrl = input.manageUrl?.trim() ?? "";
  const endDate = input.trialEndUnix === null ? null : formatTrialEndDate(input.trialEndUnix);

  if (!manageUrl || !endDate) return null;

  const t = ja.trialEnding;
  const body = [
    t.lead(endDate),
    "",
    t.amount(SENTIO_PRICE_JPY_TAX_INCLUDED),
    t.timing(endDate),
    "",
    t.cancelLead,
    manageUrl,
    "",
    t.note,
  ].join("\n");

  return { subject: t.subject(endDate), body };
}
