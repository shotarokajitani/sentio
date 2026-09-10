/**
 * メールのフッター（発注 ③-8）。**毎朝も週次も同じものを使う。**
 *
 * ## なぜ要るか
 *
 * いまのフッターは「Sentio — 報告ゼロで見える」の1行だけである。
 * **誰が送っているのか、どこに問い合わせればいいのか、止めたいときどうするのかが
 * どこにも書いていない。**
 *
 * 特定商取引法の表示義務とは別に、**受け取る側から見て「素性の分からない
 * 自動送信」に見える**のが問題である。毎朝届くものが素性不明では、
 * 読む前に迷惑メールとして処理される。
 *
 * ## 何を置くか
 *
 *   1. 事業者名と住所
 *   2. 問い合わせ先
 *   3. 配信停止の方法
 *   4. ダッシュボードで根拠を見る
 *   5. 見ているもの・見ていないもの（`/transparency`）
 *
 * 4 と 5 は**主張に根拠を付ける導線**である。メールの中で完結させるが、
 * 「なぜそう言えるのか」を辿れる口を必ず残す。
 */

/** 事業者の表示（`docs/product/mocks/` の試案と同じ） */
export const COMPANY_NAME = "株式会社ディセーノ";
export const COMPANY_ADDRESS = "〒150-0043 東京都渋谷区道玄坂1丁目10番8号 渋谷道玄坂東急ビル2F-C";
export const SUPPORT_EMAIL = "support@mdc-diseno.com";

export interface FooterLinks {
  /** ダッシュボード（根拠を見る） */
  dashboardUrl: string;
  /** 見ているもの・見ていないもの */
  transparencyUrl: string;
}

/**
 * フッターの本文（テキスト版）。
 *
 * **リンクが無くても壊れない。** 環境変数が入っていない環境では
 * URL の行を落とし、事業者の表示と問い合わせ先だけを出す——
 * 素性が分からないメールにはしない。
 */
export function renderFooterText(links: Partial<FooterLinks> = {}): string {
  const lines = [
    "───",
    `${COMPANY_NAME}　${COMPANY_ADDRESS}`,
    `お問い合わせ: ${SUPPORT_EMAIL}`,
    `配信の停止をご希望の場合は、${SUPPORT_EMAIL} までご連絡ください。`,
  ];
  if (links.dashboardUrl) lines.push(`ダッシュボードで根拠を見る: ${links.dashboardUrl}`);
  if (links.transparencyUrl) {
    lines.push(`Sentio が見ているもの・見ていないもの: ${links.transparencyUrl}`);
  }
  return lines.join("\n");
}

/**
 * 画面の起点から2つの URL を組む。**未設定なら空にする。**
 *
 * 「準備中」や `#` を入れない。押せないリンクを出すと、
 * **押した人は壊れていると判断する。**
 */
export function footerLinks(origin: string | null | undefined): Partial<FooterLinks> {
  const base = (origin ?? "").trim().replace(/\/$/, "");
  if (!base) return {};
  return { dashboardUrl: `${base}/connect`, transparencyUrl: `${base}/transparency` };
}
