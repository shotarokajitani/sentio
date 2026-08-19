/**
 * 日付キーの基準。
 *
 * **Sentio の日次・週次のキーは、常に JST 基準で作る。例外を作らない。**
 *
 * 理由は運用の読み手に合わせるためである。調査予算の上限は運用者（日本）が
 * 「今日はもう回さない」と読む単位であり、配信の対象日と一致していないと突合できない。
 * UTC 基準にすると上限のリセットが毎朝 9時 JST になり、
 * 配信の冪等キー（`pulse:<company_id>:<JST日付>`）と1日の切れ目がずれる。
 *
 * 2026-08-19 まで `_shared/budget.ts` の `budgetDateKey` だけが UTC 基準で、
 * 同じPRの中に「日次」の意味が2つある状態だった（検収者指摘）。ここに寄せて解消した。
 *
 * **新しく日付キーを作るときは、必ずこのファイルの関数を使うこと。**
 * `toISOString().slice(0, 10)` を各所で書くと、また基準が割れる。
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** JST に寄せた `YYYY-MM-DD`。 */
export function jstDateKey(at: Date): string {
  return new Date(at.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** JST に寄せた ISO 週（`YYYY-Www`）。週は月曜始まり。 */
export function isoWeekKey(at: Date): string {
  const jst = new Date(at.getTime() + JST_OFFSET_MS);
  // ISO 8601: その週の木曜が属する年を「週の年」とする
  const thursday = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()));
  const dayOfWeek = (thursday.getUTCDay() + 6) % 7; // 月曜=0
  thursday.setUTCDate(thursday.getUTCDate() - dayOfWeek + 3);

  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstDayOfWeek = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayOfWeek + 3);

  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
