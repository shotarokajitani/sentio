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

const GUARD_NAMES = new Set(["mustData", "mustOk"]);

export interface Violation {
  file: string;
  line: number;
  table: string;
}

/**
 * コメントと文字列リテラルを同じ長さの空白に置き換える。
 * 長さを保つのは、後段で算出する行番号を元ソースとずらさないため。
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
