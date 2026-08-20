/// <reference types="node" />

/**
 * S-4-8: 越境封鎖の「適用漏れ」を機械的に検出する。
 *
 * 突合先を `.github/workflows/deploy.yml` にしているのは、
 * 検出したいのが「**デプロイされているのに封鎖されていない**」だからである。
 * `supabase/functions/` のディレクトリ一覧を正とすると、デプロイ対象でないものまで
 * 巻き込み、逆に deploy.yml にだけ足された関数は見逃す。
 *
 * 新しい Function を足すときに `resolveCaller` を呼び忘れる未来は確実に来る。
 * それをレビューではなく機械で止める。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type UnguardedReason = "missing-file" | "no-resolve-caller";

export interface Unguarded {
  name: string;
  reason: UnguardedReason;
}

/** deploy.yml の `supabase functions deploy <name>` から関数名を抽出する。 */
export function parseDeployTargets(yml: string): string[] {
  const pattern = /supabase\s+functions\s+deploy\s+([A-Za-z0-9_-]+)/g;
  const names: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(yml)) !== null) {
    if (!names.includes(match[1])) names.push(match[1]);
  }

  return names;
}

/** 行コメント・ブロックコメントを落とす（コメントアウトされた呼び出しを封鎖済みと誤認しないため）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/[^\n]*$/gm, (line) => {
    const idx = line.indexOf("//");
    return line.slice(0, idx);
  });
}

/**
 * import しているだけで呼んでいない状態を封鎖済みと誤認しないため、
 * `import` 文を除いたうえで `resolveCaller(` の呼び出しを探す。
 */
function callsResolveCaller(source: string): boolean {
  const code = stripComments(source).replace(
    /^\s*import\s[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm,
    "",
  );
  return /\bresolveCaller\s*\(/.test(code);
}

export function findUnguarded(
  targets: string[],
  readIndex: (name: string) => string | null,
): Unguarded[] {
  const result: Unguarded[] = [];

  for (const name of targets) {
    const source = readIndex(name);
    if (source === null) {
      result.push({ name, reason: "missing-file" });
      continue;
    }
    if (!callsResolveCaller(source)) {
      result.push({ name, reason: "no-resolve-caller" });
    }
  }

  return result;
}

function readFunctionIndex(name: string): string | null {
  const path = join("supabase", "functions", name, "index.ts");
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const deployYmlPath = process.argv[2] ?? join(".github", "workflows", "deploy.yml");
  const targets = parseDeployTargets(readFileSync(deployYmlPath, "utf8"));

  // 対象0件で緑になるのは検査の空洞そのもの（check:allowlist と同型）なので fail させる
  if (targets.length === 0) {
    console.error(`check:caller-guard — ${deployYmlPath} からデプロイ対象を1件も抽出できなかった`);
    console.error("検査対象が空のまま緑を返さない。deploy.yml の書式変更を疑うこと。");
    process.exit(1);
  }

  const unguarded = findUnguarded(targets, readFunctionIndex);

  if (unguarded.length === 0) {
    console.log(
      `check:caller-guard — デプロイ対象 ${targets.length}本すべてが resolveCaller を通っている`,
    );
    process.exit(0);
  }

  console.error(
    `check:caller-guard — 封鎖漏れ ${unguarded.length}本 / デプロイ対象 ${targets.length}本`,
  );
  console.error("");
  for (const u of unguarded) {
    const detail =
      u.reason === "missing-file"
        ? "deploy 対象だが supabase/functions/<name>/index.ts が無い"
        : "resolveCaller() を呼んでいない（契約 S-4-8）";
    console.error(`  ${u.name}: ${detail}`);
  }
  process.exit(1);
}
