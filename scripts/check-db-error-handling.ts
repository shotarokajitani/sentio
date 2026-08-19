/// <reference types="node" />

/**
 * S-2-4: Edge Function 内の「DBエラーの握りつぶし」を機械的に検出する。
 *
 * 規約は1本に単純化してある:
 *   **Edge Function 内の Supabase クライアントの `.from()` は、必ず `mustData()` / `mustOk()` で包む。**
 *
 * `const { data } = await supabase...` のような「error を受け取らない分割代入」を
 * 個別に探す方式は取らない。書き方の変種（`.then()`・`Promise.all` の要素・
 * 戻り値を捨てる文）を数え上げる形になり、必ず取りこぼすため。
 * 「包まれているか」だけを見れば、変種の数に依存せず判定できる。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * `.from()` を持つが Supabase クライアントではない受け手。
 * `Array.from()` は実際に investigate/index.ts で使われており、除外しないと誤検知になる。
 */
const NON_DB_RECEIVERS = new Set([
  "Array",
  "Object",
  "Buffer",
  "Set",
  "Map",
  "Promise",
  "Date",
  "Number",
  "String",
  "BigInt",
  "Uint8Array",
  "Int8Array",
  "Uint16Array",
  "Int16Array",
  "Uint32Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
]);

/**
 * 正規形は3つ。`takeError` は throw が正しくない場所（呼び出し元に理由を返す経路）用で、
 * **除外リストの代わり**に置いている。除外リストは次に足す人が増やす対象になるが、
 * 「エラーを必ず受け取る形」を増やすぶんには穴が広がらない。
 */
const GUARD_NAMES = new Set(["mustData", "mustMaybe", "mustOk", "mustCount", "takeError"]);

export interface Violation {
  file: string;
  line: number;
  table: string;
}

/**
 * `/` の直前がこれらの語なら、その `/` は除算ではなく正規表現の開始である。
 * （`return /re/.test(x)` のような形。識別子で終わっていれば除算とみなす）
 */
const KEYWORDS_BEFORE_REGEX = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

/**
 * `source[i] === "/"` が正規表現リテラルの開始かどうかを、直前の意味のあるトークンで判定する。
 *
 * 完全な字句解析はしていない。判定を誤ったときの向きだけは意識してある:
 * **除算を正規表現と読むと後続コードを飲み込んで見えなくなる**（＝静かな見逃し）ので、
 * 迷ったら除算に倒す。識別子・数値・`)`・`]`・閉じ引用符の直後は除算とする。
 */
function isRegexStart(code: readonly string[], i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(code[j])) j--;
  if (j < 0) return true;

  const ch = code[j];

  // 文字列リテラルの直後（引用符は blankOutNonCode が残す）は除算
  if (ch === '"' || ch === "'" || ch === "`") return false;
  if (ch === ")" || ch === "]") return false;

  if (/[\w$]/.test(ch)) {
    let start = j + 1;
    while (start > 0 && /[\w$]/.test(code[start - 1])) start--;
    return KEYWORDS_BEFORE_REGEX.has(code.slice(start, j + 1).join(""));
  }

  return true;
}

/** 正規表現リテラルの終端（閉じ `/` の位置）。文字クラス `[...]` 内の `/` では終端しない。 */
function endOfRegex(source: string, start: number): number {
  let i = start + 1;
  let inClass = false;

  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    // 正規表現リテラルは改行をまたげない。またぐなら読み違えているので打ち切る
    if (ch === "\n") return -1;
    if (inClass) {
      if (ch === "]") inClass = false;
    } else if (ch === "[") {
      inClass = true;
    } else if (ch === "/") {
      return i;
    }
    i++;
  }

  return -1;
}

/**
 * コメント・文字列リテラル・正規表現リテラルを同じ長さの空白に置き換える。
 * 長さを保つのは、後段で算出する行番号を元ソースとずらさないため。
 *
 * **正規表現を扱うのは飾りではない。** 2026-08-19 に `day0/index.ts:142` の
 * `/<meta[^>]+charset=["']?([^"'\s;>]+)/i` を文字列の開始と読み違え、
 * 142行目以降のほぼ全域が「文字列の中身」として空白化されていた。
 * その結果 `day0` の握りつぶし2件（`:953` / `:1009` — どちらも送信部の
 * `delivery_log` 書き込み）が**検出されないまま緑になっていた**。
 * 検査が落ちるのではなく静かに見えなくなる形なので、テストで固定してある。
 */
function blankOutNonCode(source: string): string {
  const out = source.split("");
  let i = 0;
  const n = source.length;

  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };

  while (i < n) {
    const two = source.slice(i, i + 2);

    if (two === "//") {
      let j = i;
      while (j < n && source[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }

    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      const j = end === -1 ? n : end + 2;
      blank(i, j);
      i = j;
      continue;
    }

    const ch = source[i];

    if (ch === "/" && isRegexStart(out, i)) {
      const end = endOfRegex(source, i);
      if (end !== -1) {
        // 区切りの `/` ごと潰す。中身に `.from(` や引用符があっても拾わせない
        blank(i, end + 1);
        i = end + 1;
        continue;
      }
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < n) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === ch) break;
        j++;
      }
      // 中身だけを潰し、引用符は残す（`.from("events")` の表名は別途 元ソースから読む）
      blank(i + 1, j);
      i = Math.min(j + 1, n);
      continue;
    }

    i++;
  }

  return out.join("");
}

/**
 * `.from(` の直前が `mustData(` / `mustOk(`（間に `await` と空白のみ）かどうか。
 * receiverStart は受け手識別子の開始位置。
 */
function isGuarded(code: string, receiverStart: number): boolean {
  let i = receiverStart - 1;

  const skipSpace = () => {
    while (i >= 0 && /\s/.test(code[i])) i--;
  };

  skipSpace();

  // 任意の `await`
  if (i >= 4 && code.slice(i - 4, i + 1) === "await") {
    i -= 5;
    skipSpace();
  }

  if (i < 0 || code[i] !== "(") return false;
  i--;
  skipSpace();

  // 型引数つきの呼び出し（`mustMaybe<{ id: string }>(...)`）を飛ばす。
  // `mustMaybe` は期待する行の形を型引数で明示する契約なので、
  // ここを見ないと**正しく包んだ箇所を握りつぶしとして報告する**（2026-08-20 実測）
  if (i >= 0 && code[i] === ">" && code[i - 1] !== "=") {
    let depth = 0;
    while (i >= 0) {
      if (code[i] === ">" && code[i - 1] !== "=") depth++;
      else if (code[i] === "<") {
        depth--;
        if (depth === 0) break;
      }
      i--;
    }
    if (i < 0) return false;
    i--;
    skipSpace();
  }

  const end = i + 1;
  let start = end;
  while (start > 0 && /[\w$]/.test(code[start - 1])) start--;

  return GUARD_NAMES.has(code.slice(start, end));
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

export function findSwallowedDbCalls(source: string, file: string): Violation[] {
  const code = blankOutNonCode(source);
  const violations: Violation[] = [];

  // 受け手識別子 → 任意の空白/改行 → `.from(` → 引用符 → 表名
  const pattern = /([A-Za-z_$][\w$]*)\s*\.from\(\s*["'`]/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    const receiver = match[1];
    if (NON_DB_RECEIVERS.has(receiver)) continue;

    const receiverStart = match.index;
    if (isGuarded(code, receiverStart)) continue;

    // 表名は元ソースから読む（code 側は文字列の中身を潰してある）
    const quoteIndex = match.index + match[0].length - 1;
    const quote = source[quoteIndex];
    const close = source.indexOf(quote, quoteIndex + 1);
    const table = close === -1 ? "(unknown)" : source.slice(quoteIndex + 1, close);

    violations.push({ file, line: lineOf(source, receiverStart), table });
  }

  return violations;
}

function walkTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkTsFiles(full, acc);
    } else if (entry.endsWith(".ts")) {
      acc.push(full);
    }
  }
  return acc;
}

export function scanDirectory(root: string): Violation[] {
  return walkTsFiles(root).flatMap((file) =>
    findSwallowedDbCalls(readFileSync(file, "utf8"), relative(process.cwd(), file)),
  );
}

// `file://${process.argv[1]}` の連結は Windows で一致しない（argv[1] が
// バックスラッシュ区切りかつスラッシュ2本になる）。pathToFileURL で正規化する。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2] ?? "supabase/functions";
  const violations = scanDirectory(root);

  if (violations.length === 0) {
    console.log(`check:db-errors — ${root} 配下に握りつぶしなし`);
    process.exit(0);
  }

  console.error(`check:db-errors — 握りつぶし ${violations.length}件`);
  console.error("");
  console.error("Supabase の .from() は mustData() / mustOk() で包むこと（契約 S-2-1 / S-2-4）:");
  console.error("");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  .from("${v.table}")`);
  }
  process.exit(1);
}
