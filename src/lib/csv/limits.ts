/**
 * CSV の大きさの上限（2026-09-13 の点検・PR-3 の 18）。**判断だけを持つ。**
 *
 * `csv/ingest` と `csv/analyze` は上限を持っていなかった。認証済みなら、
 * 巨大な本文を送りつけてサーバの処理時間とメモリを使わせることができた。
 *
 * 数字は発注の値。銀行・会計ソフトの明細の1年分は、実測で数千行・数百 KB に収まる。
 */

/** `csv_text` の大きさ（UTF-8 のバイト数） */
export const CSV_MAX_BYTES = 2 * 1024 * 1024;
/** データ行の数（**見出しの1行は数えない**） */
export const CSV_MAX_ROWS = 20_000;
/** `csv/analyze` に送る見出しの列数 */
export const CSV_MAX_COLUMNS = 100;
/** 見出しの1列の文字数 */
export const CSV_MAX_HEADER_CHARS = 200;

export type CsvSizeVerdict =
  | { ok: true; rows: number }
  | { ok: false; reason: "too_many_bytes"; bytes: number }
  | { ok: false; reason: "too_many_rows"; rows: number };

/**
 * 取り込む本文が上限に収まるか。
 *
 * **バイト数を先に見る。** 行に分ける前に断れば、巨大な本文を分割する処理そのものを走らせない。
 */
export function checkCsvSize(csvText: string): CsvSizeVerdict {
  const bytes = Buffer.byteLength(csvText, "utf8");
  if (bytes > CSV_MAX_BYTES) return { ok: false, reason: "too_many_bytes", bytes };

  const lines = csvText
    .trim()
    .split("\n")
    .filter((l) => l.trim() !== "");
  const rows = Math.max(0, lines.length - 1);
  if (rows > CSV_MAX_ROWS) return { ok: false, reason: "too_many_rows", rows };
  return { ok: true, rows };
}

export type HeaderSizeVerdict =
  | { ok: true }
  | { ok: false; reason: "too_many_columns"; columns: number }
  | { ok: false; reason: "header_too_long"; column: number; chars: number };

/**
 * `csv/analyze` に送られた見出しが上限に収まるか。
 *
 * 見出しはそのままプロンプトに入るので、長さを絞らないと LLM の入力を膨らませられる。
 * **断った理由に見出しの中身を載せない**（列の番号と文字数だけ）。
 */
export function checkHeaderSize(headers: unknown[]): HeaderSizeVerdict {
  if (headers.length > CSV_MAX_COLUMNS) {
    return { ok: false, reason: "too_many_columns", columns: headers.length };
  }
  for (let i = 0; i < headers.length; i++) {
    const chars = String(headers[i] ?? "").length;
    if (chars > CSV_MAX_HEADER_CHARS)
      return { ok: false, reason: "header_too_long", column: i + 1, chars };
  }
  return { ok: true };
}
