/**
 * 「連携が切れています」のお知らせ（PS-9b / 承認された文面 PS-S4）。
 *
 * **テンプレートはここ1箇所だけに置く。** 文面を関数ごとに書くと、直したつもりの版と
 * 送られている版が割れる。**LLM は通らない**（PS-9c）——差し込むのは3つだけで、
 * 翻訳する対象が無い。
 *
 * 差し込みは **{会社名} / {検知日時 JST} / {再連携URL}** の3つ。
 * **1つでも欠けたら組み立てない。** 欠けたまま送ると
 * 「(不明) の連携が切れています」のような文面が顧客に届く。
 *
 * ## 文面の意図（変更は検収者に諮る）
 *
 * - **「配信を停止します」は必須。** 無いと、レポートが来ないことを
 *   「異常がないから来ない」と読める。2026-09-03〜09-06 に実際に起きた誤読である
 * - **「記録されません」は必須。** 後から遡って埋まると思われると、再連携が後回しになる
 * - **「7日ごとに配信します」は必須。** 無いと、1通目のあとの沈黙を「直った」と読める
 */

export interface ReconnectNoticeInput {
  /** 宛先の会社を指す名前。**内部IDでもメールアドレスでもない** */
  companyName: string;
  /** 連携が切れたことを検知した時刻（ISO 8601） */
  detectedAt: string;
  /** 再連携の入口。公開オリジンから組み立てる */
  reconnectUrl: string;
}

export interface ReconnectNotice {
  subject: string;
  body: string;
}

/** provider の**内部表記を顧客に見せない**。`google_calendar` ではなく「Googleカレンダー」 */
const PROVIDER_LABEL = "Googleカレンダー";

/** JST の「2026年9月3日 15:00」。**タイムゾーンを固定する**（受け手は日本にいる） */
export function formatDetectedAt(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;

  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  // `ja-JP` の `formatToParts` は「月」を literal として別に返す（month は "9"）。
  // **部品を連結するときに単位を落とさない**（"2026年93日" になっていた）
  return `${get("year")}年${get("month")}月${get("day")}日 ${get("hour")}:${get("minute")}`;
}

/**
 * 文面を組み立てる。**差し込みが1つでも欠けたら `null` を返す。**
 *
 * 返さないことで、呼び出し側は送信に入れない（fail-closed）。
 * **「(不明)」で埋めて送る形にしない。**
 */
export function renderReconnectNotice(input: ReconnectNoticeInput): ReconnectNotice | null {
  const companyName = input.companyName?.trim() ?? "";
  const reconnectUrl = input.reconnectUrl?.trim() ?? "";
  const detectedAt = input.detectedAt ? formatDetectedAt(input.detectedAt) : null;

  if (!companyName || !reconnectUrl || !detectedAt) return null;

  const body = [
    `${companyName} の${PROVIDER_LABEL}の連携が切れています。`,
    `${detectedAt} から、新しいデータを取り込めていません。`,
    "",
    "この状態が続く間、毎朝の状態レポートは配信を停止します。",
    "連携が切れている間に起きたことは、Sentioには記録されません。",
    "",
    "再連携はこちらから行えます。",
    reconnectUrl,
    "",
    "このお知らせは、状態が変わらない場合、7日ごとに配信します。",
  ].join("\n");

  return { subject: `【Sentio】${PROVIDER_LABEL}の連携が切れています`, body };
}
