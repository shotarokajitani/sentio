/**
 * 顧客に見せる面から**内部の語を排除する**（発注 ③-7）。
 *
 * ## なぜ要るか
 *
 * いまの週次メールは見出しに「今週のFinding」「状態ダイジェスト」を出している。
 * **どちらも作り手の語で、受け取る経営者の語ではない。**
 * 「Finding」が何かを知っているのは我々だけであり、読んだ人は
 * **自社の状態ではなく、道具の都合を読まされる。**
 *
 * 語を1つ混ぜるだけで、そのメールは「システムからの通知」になる。
 * ここは体裁の問題ではなく、**製品が何を届けているかの問題**である。
 *
 * ## 何を止めるか
 *
 * 件名と本文に、下の語が1つでも出たら試験を赤にする。
 * **既定は落とすほうである**——迷ったら止める側に入れる。
 *
 * ## 守れない範囲（設計上の限界。これは仕様であって不具合ではない）
 *
 * 1. **語の一覧に無いものは見ない。** 新しい内部語を作れば素通りする
 * 2. **文脈は見ない。** 顧客名や取引先名に「イベント」が入っていれば誤検知する。
 *    そのときは一覧ではなく**呼び出し側で除外する**（一覧を緩めない）
 * 3. **英語の大文字小文字だけ吸収する。** 表記ゆれ（`ファインディング`）は別に足す
 */

/** 顧客に見せる面に出してはいけない語（発注 ③-7 の一覧＋確定分） */
export const FORBIDDEN_WORDS = [
  "イベント",
  "種別",
  "Finding",
  "ファインディング",
  "パケット",
  "系列",
  "ダイジェスト",
  "schedule",
  "monitor",
  "transaction",
  "Day0",
  "状態パケット",
  "スキャン",
  "走査",
  "ベースライン",
  "baseline",
] as const;

/**
 * 本文に含まれる禁止語を返す。**0件なら空配列。**
 *
 * 英字の語は大文字小文字を区別しない。日本語はそのまま照合する。
 */
export function findForbiddenWords(text: string): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const word of FORBIDDEN_WORDS) {
    const found = /^[\x20-\x7e]+$/.test(word)
      ? lower.includes(word.toLowerCase())
      : text.includes(word);
    if (found) hits.push(word);
  }
  return hits;
}

/** 曜日。件名に出す（毎日届くので、日付だけでは受信箱で見分けが付かない） */
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** JST に寄せた日付の各部 */
function jstParts(at: Date): { y: number; m: number; d: number; w: number } {
  const jst = new Date(at.getTime() + 9 * 60 * 60 * 1000);
  return {
    y: jst.getUTCFullYear(),
    m: jst.getUTCMonth() + 1,
    d: jst.getUTCDate(),
    w: jst.getUTCDay(),
  };
}

/** 「9月10日」。年は出さない（毎朝届くので年は要らない） */
export function formatMonthDay(at: Date): string {
  const { m, d } = jstParts(at);
  return `${m}月${d}日`;
}

/** 「9月10日・木」。**曜日があると週の位相が分かる**（2026-09-10 の確定） */
export function formatMonthDayWeekday(at: Date): string {
  const { m, d, w } = jstParts(at);
  return `${m}月${d}日・${WEEKDAYS[w]}`;
}

/** 毎朝のメールの件名 */
export function pulseSubject(reportDay: Date): string {
  return `【Sentio】今日の会社（${formatMonthDayWeekday(reportDay)}）`;
}

/** 週次メールの件名。期間は「9月1日〜9月7日」 */
export function weeklySubject(from: Date, to: Date): string {
  return `【Sentio】今週の会社（${formatMonthDay(from)}〜${formatMonthDay(to)}）`;
}
