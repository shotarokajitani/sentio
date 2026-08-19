/// <reference types="node" />

/**
 * Edge Function の型検査（`deno check`）と、その**検査対象の網羅**を1本にまとめる。
 *
 * **なぜ独立したスクリプトなのか。**
 * `tsconfig.json` は各 Function の `index.ts`（`supabase/functions/<name>/index.ts`）を
 * 除外しているため、
 * `pnpm typecheck`（tsc）は Edge Function の `index.ts` を1行も見ていない。
 * 実際、2026-08-19 に typecheck / lint / unit がすべて緑の状態で
 * `deno check` が **28件**で落ちた。型検査の実体はここにしかない。
 *
 * **CI と同じ実体を1つだけ持つ。**
 * `.github/workflows/ci.yml` の `edge-functions` ジョブは、コマンドを書き写すのではなく
 * **このスクリプトを呼ぶ**。同じ内容を2箇所に書くと、片方だけ更新されたときに
 * 「検査対象から漏れているのに緑」が起きる（`check:allowlist` が1行 log で
 * 緑を返していたのと同型の空洞）。近似を別に持たないのも同じ理由で、
 * ローカルでも CI と同じ `deno check` を同じ引数で走らせる。
 *
 * ローカルで動かすには Deno が要る（CI と同じ **v2.1.4** に固定）。
 * 導入手順は `docs/runbooks/2026-08-19_pc-migration-inventory.md` の必要ツール一覧。
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Supabase Edge Runtime と同系メジャー。CI の `denoland/setup-deno` と同じ値 */
export const REQUIRED_DENO_VERSION = "2.1.4";

const FUNCTIONS_ROOT = join("supabase", "functions");

export interface CoverageCounts {
  functionDirs: number;
  indexes: number;
  shared: number;
  total: number;
}

function listTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listTsFiles(full, acc);
    else if (entry.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

export function collectCoverage(root = FUNCTIONS_ROOT): CoverageCounts {
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "_shared")
    .map((d) => d.name);

  const indexes = dirs.filter((name) => {
    try {
      return statSync(join(root, name, "index.ts")).isFile();
    } catch {
      return false;
    }
  });

  const shared = listTsFiles(join(root, "_shared"));
  const total = listTsFiles(root);

  return {
    functionDirs: dirs.length,
    indexes: indexes.length,
    shared: shared.length,
    total: total.length,
  };
}

/**
 * 検査対象が「全 Function ＋ `_shared` の全ファイル」と一致することを確かめる。
 *
 * **`deno check` の前に置くのが要点。** 対象が静かに漏れていると、
 * 検査は緑のまま「見ていないファイル」が増える。数で突き合わせて止める。
 */
export function verifyCoverage(counts: CoverageCounts): string[] {
  const problems: string[] = [];

  if (counts.functionDirs !== counts.indexes) {
    problems.push(
      `index.ts を持たない function ディレクトリがある（ディレクトリ ${counts.functionDirs} / index.ts ${counts.indexes}）`,
    );
  }
  if (counts.total !== counts.indexes + counts.shared) {
    problems.push(
      `検査対象の総数が合わない（合計 ${counts.total} ≠ index.ts ${counts.indexes} + _shared ${counts.shared}）。` +
        "function 直下以外に .ts が増えていないか確認すること",
    );
  }
  if (counts.total === 0) {
    problems.push("検査対象が0件。パスの取り違えを疑う");
  }

  return problems;
}

function denoVersion(): string | null {
  try {
    const out = execFileSync("deno", ["--version"], { encoding: "utf8" });
    return /^deno (\S+)/.exec(out.trim())?.[1] ?? null;
  } catch {
    return null;
  }
}

function main(): never {
  const counts = collectCoverage();
  console.log(
    `検査対象: function ディレクトリ ${counts.functionDirs} / index.ts ${counts.indexes} / ` +
      `_shared ${counts.shared} / 合計.ts ${counts.total}`,
  );

  const problems = verifyCoverage(counts);
  if (problems.length > 0) {
    console.error("check:edge-types — 検査対象の網羅に問題がある:");
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }

  const version = denoVersion();
  if (version === null) {
    console.error(
      `check:edge-types — deno が見つからない。CI と同じ v${REQUIRED_DENO_VERSION} を入れること` +
        "（docs/runbooks/2026-08-19_pc-migration-inventory.md の必要ツール一覧）。" +
        "**近似での代替は用意しない。** 近似が緑でも deno check が緑とは限らず、" +
        "それを緑と読むこと自体が新しい空洞になる",
    );
    process.exit(1);
  }
  if (version !== REQUIRED_DENO_VERSION) {
    // 止めはしないが黙認もしない。CLI の破壊的変更をそのまま踏むのが version: latest の失敗
    console.warn(
      `check:edge-types — deno ${version} は CI の v${REQUIRED_DENO_VERSION} と違う。差分の可能性がある`,
    );
  }

  const files = listTsFiles(FUNCTIONS_ROOT);
  // 引数は CI と同じ。`--node-modules-dir=none` はルートの node_modules に
  // 引きずられず、Deno のグローバルキャッシュで npm: を解決させる（Edge Runtime と同じ経路）
  const result = spawnSync("deno", ["check", "--no-lock", "--node-modules-dir=none", ...files], {
    stdio: "inherit",
  });

  if (result.status !== 0) {
    console.error(`check:edge-types — deno check が失敗した（exit ${result.status}）`);
    process.exit(result.status ?? 1);
  }

  console.log(`check:edge-types — ${files.length}ファイルの型検査を通過`);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
