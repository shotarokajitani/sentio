/// <reference types="node" />

/**
 * S-5-1: 各 Edge Function が読み書きする列集合を取り出し、実DBの
 * `information_schema.columns` と突合する。列が消えた／改名されたら CI が赤くなる。
 *
 * 列集合は**ソースそのものから取り出す**。手書きの宣言表を別に持たないのは、
 * 宣言表が実装から遅れた瞬間に「宣言は正しいが実装は壊れている」を緑で通してしまうため。
 * `.select("a, b")` や `.insert({ a, b })` は既に宣言的なので、それを正本として扱う。
 *
 * 取り出せない箇所（`select("*")`・変数を渡す書き込み）は**黙って飛ばさず**報告する。
 * 静かに検査対象から外れることが、このスライスを生んだ空洞そのものだからである。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";

export type AccessKind = "read" | "filter" | "write" | "conflict";

export interface ColumnAccess {
  file: string;
  line: number;
  table: string;
  column: string;
  kind: AccessKind;
}

export interface Located {
  file: string;
  line: number;
  table: string;
}

export interface ExtractResult {
  accesses: ColumnAccess[];
  /** `select("*")`。列を明示していないため突合できない */
  starSelects: Located[];
  /** `.insert(rows)` のようにオブジェクトリテラルでない書き込み */
  unverifiableWrites: Located[];
}

/** 第1引数が列名である PostgREST のメソッド。 */
const COLUMN_FIRST_ARG = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "is",
  "in",
  "contains",
  "containedBy",
  "overlaps",
  "order",
  "not",
  "filter",
  "rangeGt",
  "rangeLt",
]);

const WRITE_METHODS = new Set(["insert", "upsert", "update"]);

/** コメントを同じ長さの空白に置き換える（行番号を保つ）。 */
function blankComments(source: string): string {
  const out = source.split("");
  const n = source.length;
  let i = 0;

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
    // 文字列は中身を残す（列名が入っているため）が、その中の `//` を
    // コメント開始と誤認しないよう読み飛ばす
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
      i = Math.min(j + 1, n);
      continue;
    }
    i++;
  }

  return out.join("");
}

/** `open` の位置（`(` または `{`）から対応する閉じ括弧の位置を返す。文字列は読み飛ばす。 */
function matchBracket(code: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const closeChar = pairs[code[open]];
  let depth = 0;

  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i++;
      while (i < code.length && code[i] !== ch) {
        if (code[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === code[open]) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source[i] === "\n") line++;
  return line;
}

/** オブジェクトリテラルのトップレベルのキーを取り出す。 */
function topLevelKeys(objectText: string): string[] {
  const inner = objectText.slice(1, -1);
  const keys: string[] = [];
  let depth = 0;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i++;
      while (i < inner.length && inner[i] !== ch) {
        if (inner[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
  }

  // 深さを追いながらキーを拾う（ネストの内側は無視する）
  depth = 0;
  let tokenStart = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i++;
      while (i < inner.length && inner[i] !== ch) {
        if (inner[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") {
      depth++;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      continue;
    }
    if (depth !== 0) continue;

    if (ch === ",") {
      tokenStart = i + 1;
      continue;
    }
    if (ch === ":") {
      const key = inner
        .slice(tokenStart, i)
        .trim()
        .replace(/^["'`]|["'`]$/g, "");
      if (/^[A-Za-z_$][\w$]*$/.test(key)) keys.push(key);
      tokenStart = i + 1;
      // 値の側にコロンが現れても拾わないよう、次のトップレベル `,` まで進める
      let j = i + 1;
      let d = 0;
      for (; j < inner.length; j++) {
        const c = inner[j];
        if (c === '"' || c === "'" || c === "`") {
          j++;
          while (j < inner.length && inner[j] !== c) {
            if (inner[j] === "\\") j++;
            j++;
          }
          continue;
        }
        if (c === "{" || c === "[" || c === "(") d++;
        else if (c === "}" || c === "]" || c === ")") d--;
        else if (c === "," && d === 0) break;
      }
      i = j;
      tokenStart = j + 1;
    }
  }

  return keys;
}

/** メソッド呼び出しの引数テキストを `,` でトップレベル分割する。 */
function splitArgs(argsText: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < argsText.length; i++) {
    const ch = argsText[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i++;
      while (i < argsText.length && argsText[i] !== ch) {
        if (argsText[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(argsText.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(argsText.slice(start).trim());
  return parts.filter((p) => p.length > 0);
}

function stringLiteral(text: string): string | null {
  const m = /^(["'`])([\s\S]*)\1$/.exec(text.trim());
  return m ? m[2] : null;
}

export function extractTableAccess(source: string, file: string): ExtractResult {
  const code = blankComments(source);
  const accesses: ColumnAccess[] = [];
  const starSelects: Located[] = [];
  const unverifiableWrites: Located[] = [];

  const fromPattern = /\.from\(\s*["'`]([A-Za-z_][\w]*)["'`]\s*\)/g;
  let match: RegExpExecArray | null;

  while ((match = fromPattern.exec(code)) !== null) {
    const table = match[1];
    const line = lineOf(source, match.index);
    const push = (column: string, kind: AccessKind, at: number) =>
      accesses.push({ file, line: lineOf(source, at), table, column, kind });

    // `.from("t")` の直後からメソッドチェーンを辿る
    let cursor = match.index + match[0].length;

    for (;;) {
      const rest = code.slice(cursor);
      const chain = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(rest);
      if (!chain) break;

      const method = chain[1];
      const openParen = cursor + chain[0].length - 1;
      const closeParen = matchBracket(code, openParen);
      if (closeParen === -1) break;

      const argsText = code.slice(openParen + 1, closeParen);
      const args = splitArgs(argsText);

      if (method === "select") {
        const spec = args[0] === undefined ? "*" : (stringLiteral(args[0]) ?? "*");
        if (spec.trim() === "*") {
          starSelects.push({ file, line: lineOf(source, openParen), table });
        } else {
          for (const raw of spec.split(",")) {
            const col = raw.trim().split(":").pop()!.trim();
            if (/^[A-Za-z_][\w]*$/.test(col)) push(col, "read", openParen);
          }
        }
      } else if (method === "or") {
        const spec = args[0] ? stringLiteral(args[0]) : null;
        if (spec) {
          for (const clause of spec.split(",")) {
            const col = clause.split(".")[0].trim();
            if (/^[A-Za-z_][\w]*$/.test(col)) push(col, "filter", openParen);
          }
        }
      } else if (COLUMN_FIRST_ARG.has(method)) {
        const col = args[0] ? stringLiteral(args[0]) : null;
        if (col && /^[A-Za-z_][\w]*$/.test(col)) push(col, "filter", openParen);
      } else if (WRITE_METHODS.has(method)) {
        const payload = args[0] ?? "";
        const objectText = payload.startsWith("{")
          ? payload
          : payload.startsWith("[") && payload.includes("{")
            ? payload.slice(payload.indexOf("{"), payload.lastIndexOf("}") + 1)
            : null;

        if (objectText) {
          for (const key of topLevelKeys(objectText)) push(key, "write", openParen);
        } else {
          unverifiableWrites.push({ file, line: lineOf(source, openParen), table });
        }

        // upsert の第2引数 `{ onConflict: "a,b" }`
        const options = args[1];
        if (options) {
          const oc = /onConflict\s*:\s*["'`]([^"'`]+)["'`]/.exec(options);
          if (oc) {
            for (const col of oc[1].split(",")) {
              const c = col.trim();
              if (/^[A-Za-z_][\w]*$/.test(c)) push(c, "conflict", openParen);
            }
          }
        }
      }

      cursor = closeParen + 1;
    }
  }

  return { accesses, starSelects, unverifiableWrites };
}

function walkTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkTsFiles(full, acc);
    else if (entry.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

export function scanDirectory(root: string): ExtractResult {
  const merged: ExtractResult = { accesses: [], starSelects: [], unverifiableWrites: [] };

  for (const file of walkTsFiles(root)) {
    const rel = relative(process.cwd(), file);
    const r = extractTableAccess(readFileSync(file, "utf8"), rel);
    merged.accesses.push(...r.accesses);
    merged.starSelects.push(...r.starSelects);
    merged.unverifiableWrites.push(...r.unverifiableWrites);
  }

  return merged;
}

/** 実DBから public スキーマの テーブル→列 を取る。 */
async function fetchLiveColumns(): Promise<Map<string, Set<string>>> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // env が無ければ「検査せず緑」ではなく失敗させる（S-5-4 と同じ fail-closed）
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定。実DBに当たれないため検査を成立させない",
    );
  }

  const supabase = createClient(url, key, { db: { schema: "information_schema" } });
  const { data, error } = await supabase
    .from("columns")
    .select("table_name, column_name")
    .eq("table_schema", "public");

  if (error) throw new Error(`information_schema.columns の取得に失敗: ${error.message}`);

  const map = new Map<string, Set<string>>();
  for (const row of (data ?? []) as { table_name: string; column_name: string }[]) {
    if (!map.has(row.table_name)) map.set(row.table_name, new Set());
    map.get(row.table_name)!.add(row.column_name);
  }
  return map;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2] ?? "supabase/functions";
  const extracted = scanDirectory(root);

  let failed = false;

  if (extracted.starSelects.length > 0) {
    failed = true;
    console.error(`check:schema — select("*") が ${extracted.starSelects.length}件`);
    console.error("列を明示すること。`*` のままでは列の消失・改名を検査できない（契約 S-5-1）:");
    for (const s of extracted.starSelects) {
      console.error(`  ${s.file}:${s.line}  .from("${s.table}").select("*")`);
    }
    console.error("");
  }

  // 静的に読めない書き込みは「飛ばした」ことを必ず出す。黙って緑にしない
  if (extracted.unverifiableWrites.length > 0) {
    console.warn(
      `check:schema — 静的に列を読めない書き込み ${extracted.unverifiableWrites.length}件（実DBテスト S-5-2 の担当）:`,
    );
    for (const w of extracted.unverifiableWrites) {
      console.warn(`  ${w.file}:${w.line}  .from("${w.table}")`);
    }
    console.warn("");
  }

  const live = await fetchLiveColumns();
  const unknown: ColumnAccess[] = [];

  for (const a of extracted.accesses) {
    const cols = live.get(a.table);
    if (!cols) {
      unknown.push({ ...a, column: `(テーブルが存在しない: ${a.table})` });
      continue;
    }
    if (!cols.has(a.column)) unknown.push(a);
  }

  if (unknown.length > 0) {
    failed = true;
    console.error(`check:schema — 実DBに存在しない列への参照 ${unknown.length}件:`);
    for (const u of unknown) {
      console.error(`  ${u.file}:${u.line}  ${u.table}.${u.column} (${u.kind})`);
    }
  }

  if (failed) process.exit(1);

  console.log(
    `check:schema — 参照 ${extracted.accesses.length}件すべてが実DBの列と一致（テーブル ${live.size}件を照会）`,
  );
}
