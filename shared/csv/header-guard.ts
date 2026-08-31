/**
 * 1行目が「列名の行」かどうかの判定（契約 `docs/contracts/slice-csv-headerguard.md`・スライスCH）。
 *
 * **なぜ純関数を shared に置くか（CH-D3）。**
 * この判定はクライアント（`fetch` の手前）とサーバ（`/api/csv/analyze`）の
 * **2箇所で使う**。二重に実装すると、片方だけ直した日に穴が開く。
 * 実装は1つだけ持ち、両方がこれを読む。
 *
 * **何から守っているか。**
 * 列名は `/api/csv/analyze` のプロンプトに `- "列名": 型=…` の形で**そのまま載る**。
 * 2026-08-31、列名の行が無い全銀協規定フォーマット系のファイルが投入され、
 * 銀行名・支店名・口座番号・口座名義が「列名」として Anthropic API に送られた
 * （`docs/reports/2026-08-31_CSV_ヘッダー行前提が崩れる.md`）。
 * `route.ts` の「no string cell values - PII protection」というコメントは嘘ではなく、
 * **「1行目が列名である」という前提が明示されていなかった**だけである。
 * ここはその前提を、前提のまま置かずに検査する。
 *
 * **判定に半角カナを使わない（CH-D5）。**
 * 事故のファイルは半角カナが目印だったが、半角カナの列名を書き出す会計ソフトはありうる。
 * 数値・日付・空の3つだけで実物は 17列中14 が該当する。**足りている。**
 */

/**
 * 「列名らしくない」セルがこの割合以上なら、列名の行ではないと見なす。
 *
 * **定数1つで固定する。** env や設定で可変にしない（契約の停止点）。
 * 環境ごとに閾値が違うと、本番だけ通る／本番だけ落ちるという最悪の形になる。
 */
export const NON_NAME_LIKE_RATIO = 0.5;

/** 判定の内訳。文言と検査で使う。**セルの中身は持たない**（CH-1-4） */
export interface HeaderRowVerdict {
  isHeader: boolean;
  /** 1行目のセル数 */
  total: number;
  /** そのうち「数値のみ / 日付 / 空」だった数 */
  nonNameLike: number;
}

/**
 * 数値のみ。桁区切りのカンマ・符号・小数点を含めて数える（`9,999,999` / `-1234` / `1.5`）。
 *
 * 単位や記号が付いたもの（`金額(円)` / `No.1`）は数値としない。
 * **誤検知を出さない側に倒す。** 列名らしくないものを数え損ねても取り込みは通るが、
 * 列名を数値と誤認すると、正しいCSVが断られる。
 */
function isNumberOnly(cell: string): boolean {
  return /^[+-]?\d+(\.\d+)?$/.test(cell.replace(/,/g, ""));
}

/**
 * 日付として解釈できる形。**年月日が揃ったものだけ**を日付とする。
 *
 * `2026年8月` のような年月（日が無い）を日付に数えないのは、それが
 * **列名として正しい**からである（`項目,2026年8月,2026年9月` は月次の集計表の列名）。
 * ここを数えると CH-2-4 が 2/3 で落ちる。**年月は列名、年月日はデータ**で線を引く。
 *
 * `20260801` や `80830` のような区切りの無い形は `isNumberOnly` が既に拾う。
 */
function isDateLike(cell: string): boolean {
  // 2026-08-01 / 2026/8/1（後ろに時刻が続く形も含む）
  if (/^\d{4}[/-]\d{1,2}[/-]\d{1,2}(\D|$)/.test(cell)) return true;
  // 2026年8月1日
  if (/^\d{4}年\d{1,2}月\d{1,2}日?/.test(cell)) return true;
  return false;
}

/** 1行目のセル1つが「列名らしくない」か。数値のみ / 日付 / 空 の3つだけを見る（CH-D4） */
function isNonNameLike(cell: string): boolean {
  const value = cell.trim();
  if (value === "") return true;
  return isNumberOnly(value) || isDateLike(value);
}

/**
 * 1行目の内訳を数える。
 *
 * **空配列は列名の行ではない**（`isHeader: false`）。列が1つも無いものに対応表は作れず、
 * ここで true を返すと「0件だから通す」という素通しの穴になる。fail-closed に倒す。
 *
 * **1セルだけのときも同じ規則を当てる。** 特別扱いを作らない。
 * `["摘要"]` は通り、`["9999999"]` は落ちる。
 */
export function inspectHeaderRow(cells: string[]): HeaderRowVerdict {
  const total = cells.length;
  const nonNameLike = cells.filter(isNonNameLike).length;

  // 「半数以上なら列名の行ではない」＝ちょうど半数は落とす。
  // したがって通すのは**半数未満**のときだけである（CH-2-4 が固定している境界）
  const isHeader = total > 0 && nonNameLike < total * NON_NAME_LIKE_RATIO;

  return { isHeader, total, nonNameLike };
}

/** 1行目が列名の行に見えるか。false なら送信前に止める */
export function looksLikeHeaderRow(cells: string[]): boolean {
  return inspectHeaderRow(cells).isHeader;
}
