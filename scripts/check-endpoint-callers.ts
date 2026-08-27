/// <reference types="node" />

/**
 * D-4-1（契約 docs/contracts/slice-disconnect.md）:
 * **「API はあるが、どこからも到達しない」を機械で止める。**
 *
 * このスライスが生まれた原因そのものを検査対象にしている。
 * `src/app/api/connections/disconnect/route.ts` は実装も fail-closed の門も揃っていたのに、
 * **画面にもどこにも呼び出し元が無かった。** プライバシーポリシー §6 は
 * 「Sentio の画面から連携を解除した場合」の動きを公開済みで、
 * 約束と実態がずれた窓が開いていた。
 *
 * 既存の検査器では捕まらない:
 *   - `check:caller-guard`（S-4-8）は **Edge Function** の越境封鎖しか見ない
 *   - `typecheck` / `lint` は「使われていない API ルート」を誤りとしない。
 *     Next.js の route.ts は import されずに動くのが正常だからである
 *
 * 何を見ているか。宣言した各エンドポイントについて2段で確かめる。
 *   1. `src/` 配下（`src/app/api/**` を除く）に、そのパス文字列に触れるファイルが在るか
 *      — 無ければ `no-caller`。呼び出しの実体そのものが無い
 *   2. その実体を、別のファイルが import しているか
 *      — 無ければ `no-importer`。実体はあるが誰も呼ばないので到達しない
 * 加えて、宣言した `route.ts` が実在しなければ `missing-route`（API 側の改名・削除）。
 *
 * **これは完全な到達可能性解析ではない。** import の連鎖を辿って画面まで届くことは
 * 保証しない（2段目の import 元がさらに孤立している形は捕まらない）。
 * 狙いは「1件も呼び出し元が無い」「実体はあるが誰も import していない」という、
 * 実際に起きた形を止めることである。守れない範囲を黙って残さないためここに書く。
 *
 * コメントを落としてから探すのは、コメントアウトされた呼び出しを
 * 「到達している」と誤認しないためである（`check-caller-guard.ts` と同じ理由）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

export interface EndpointSpec {
  id: string;
  /** ルートのパス文字列。呼び出し元はこれをソースに持つ */
  endpoint: string;
  /** リポジトリ相対の route.ts。存在しなければ宣言のほうが古い */
  route: string;
  /** 根拠となる契約項番 */
  contract: string;
}

/**
 * 検査対象の宣言。**空にしない。** 0件で緑になるのは検査の空洞そのものである
 * （`check:allowlist` が1行 log で緑を返していたのと同型）。
 */
export const ENDPOINT_SPECS: EndpointSpec[] = [
  {
    id: "disconnect",
    endpoint: "/api/connections/disconnect",
    route: "src/app/api/connections/disconnect/route.ts",
    contract: "D-4-1",
  },
];

export type UnreachableReason = "missing-route" | "no-caller" | "no-importer";

export interface Unreachable {
  id: string;
  reason: UnreachableReason;
}

export interface SourceFile {
  /** リポジトリ相対パス。区切りは `/` でも `\` でもよい */
  file: string;
  source: string;
}

/** 行コメント・ブロックコメントを落とす。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/[^\n]*$/gm, (line) => {
    const idx = line.indexOf("//");
    return line.slice(0, idx);
  });
}

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * `src/lib/connections/disconnect.ts` → `@/lib/connections/disconnect`。
 * tsconfig の `@/*` は `src/*` を指す。
 */
export function aliasSpecifier(file: string): string {
  return toPosix(file)
    .replace(/^src\//, "@/")
    .replace(/\.(ts|tsx)$/, "");
}

/** API ルート自身は「呼び出し元」に数えない。数えると検査が自分で自分を満たしてしまう */
function isApiRoute(file: string): boolean {
  return toPosix(file).startsWith("src/app/api/");
}

export function findUnreachable(
  specs: EndpointSpec[],
  routeExists: (route: string) => boolean,
  sources: SourceFile[],
): Unreachable[] {
  const stripped = sources.map((s) => ({
    file: toPosix(s.file),
    code: stripComments(s.source),
  }));

  const findings: Unreachable[] = [];

  for (const spec of specs) {
    if (!routeExists(spec.route)) {
      findings.push({ id: spec.id, reason: "missing-route" });
      continue;
    }

    const callers = stripped.filter((s) => !isApiRoute(s.file) && s.code.includes(spec.endpoint));
    if (callers.length === 0) {
      findings.push({ id: spec.id, reason: "no-caller" });
      continue;
    }

    // 呼び出しの実体が、別のファイルから import されているか。
    // エイリアス（`@/lib/...`）と相対（`../../lib/...`）の両方を認める
    const imported = callers.some((caller) => {
      const alias = aliasSpecifier(caller.file);
      const tail = alias.replace(/^@/, "");
      return stripped.some(
        (other) =>
          other.file !== caller.file &&
          new RegExp(`from\\s+["'][^"']*${escapeRegExp(tail)}["']`).test(other.code),
      );
    });

    if (!imported) {
      findings.push({ id: spec.id, reason: "no-importer" });
    }
  }

  return findings;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `src/` を走査して .ts / .tsx を集める。 */
function collectSources(root = "src"): SourceFile[] {
  const out: SourceFile[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      out.push({ file: toPosix(relative(".", path)), source: readFileSync(path, "utf8") });
    }
  };

  walk(root);
  return out;
}

const DETAIL: Record<UnreachableReason, string> = {
  "missing-route": "宣言した route.ts が存在しない。API の改名・削除に宣言が追随していない",
  "no-caller": "src/ のどこからもこのエンドポイントを呼んでいない（到達しない実装）",
  "no-importer": "呼び出しの実体はあるが、どのファイルもそれを import していない",
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (ENDPOINT_SPECS.length === 0) {
    console.error("check:endpoint-callers — 宣言が0件。検査対象が空のまま緑を返さない");
    process.exit(1);
  }

  const sources = collectSources();
  if (sources.length === 0) {
    console.error("check:endpoint-callers — src/ から .ts / .tsx を1件も読めなかった");
    process.exit(1);
  }

  const findings = findUnreachable(ENDPOINT_SPECS, (route) => existsSync(route), sources);

  if (findings.length === 0) {
    console.log(
      `check:endpoint-callers — 宣言 ${ENDPOINT_SPECS.length}件すべてに到達する呼び出し元がある` +
        `（走査 ${sources.length}ファイル）`,
    );
    process.exit(0);
  }

  console.error(`check:endpoint-callers — 到達しないエンドポイント ${findings.length}件:`);
  console.error("");
  for (const f of findings) {
    const spec = ENDPOINT_SPECS.find((s) => s.id === f.id);
    console.error(`  [${f.reason}] ${f.id} (${spec?.endpoint} / 契約 ${spec?.contract})`);
    console.error(`      ${DETAIL[f.reason]}`);
  }
  process.exit(1);
}
