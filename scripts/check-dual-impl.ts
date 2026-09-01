/// <reference types="node" />

/**
 * **同じ処理が `src/` と `supabase/functions/` の両方にあるのに、
 * ずれを止めるものが無い状態**を機械的に検出する。
 *
 * ## なぜ作ったか
 *
 * 2026-08-31、`runScan`（Scanner）が2つあり、**本番で走っている方だけが更新され、
 * 評価スイートは走っていない方を測り続けていた**。6週間、製品の中核が
 * 実質的に測られていなかった（`docs/reports/2026-08-31_検知5of7の内訳実測.md`）。
 *
 * このリポジトリには**二重実装を許す正しい形が既にある**（`retention` 対）。
 *
 *   1. 二重に持つ理由を書く（Edge は `supabase/functions/` の外を import できない）
 *   2. どちらが正本かを指名する
 *   3. **ずれを機械で止めるテストを付ける**
 *      （`tests/unit/retention-policy.test.ts` が両側を import して突合する）
 *
 * Scanner はそのどれでもなかった。**許されるのは「`shared/` に1つ置く」か
 * 「二重に持って突合テストを付ける」のどちらかである。**
 *
 * ## 何を見ているか
 *
 * `src/` と `supabase/functions/` の両方で定義されている**同名の関数**を突合し、
 * 宣言（`DUAL_IMPL_SPECS`）と照らす。判定は4種類。
 *
 *   - `undeclared`   — 両側に同名があるのに宣言に無い（**これが本命**）
 *   - `dangling`     — 宣言にあるが、もう両側には無い（解消済み。宣言から消す）
 *   - `missing-file` — 宣言のファイルが存在しない（改名・移動）
 *   - `missing-pin`  — `pinnedBy` を宣言しているのに、そのテストが両側を import していない
 *
 * ## 守れない範囲（設計上の限界。仕様であって不具合ではない）
 *
 * 1. **`pinnedBy: null` を許している。** 止め具の無い二重実装を「見える負債」として
 *    宣言に残せる。これを禁じると、些末なヘルパ（`unauthorized` 等）にまで
 *    突合テストを強制することになり、宣言が形骸化する。
 *    **したがってこの検査器は「止め具を強制する」ものではない。
 *    「新しい二重実装が黙って増えること」を止めるものである。**
 * 2. **関数名でしか照合しない。** 同じ処理を別名で書いたら検出できない。
 *    逆に、たまたま同名の無関係な関数は `undeclared` として出る（宣言して潰す）。
 * 3. **`pinnedBy` のテストが「実際に突合しているか」は見ない。**
 *    両側を import しているかまでしか確かめない。中身の担保はそのテスト自身の責任である
 *    （`check:ci-coverage` の「中身のある検査をしているかは見ない」と同じ）。
 */

import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface DualImplSpec {
  /** 両側に存在する関数名 */
  fn: string;
  /** `src/` 側のファイル（リポジトリ相対） */
  src: string;
  /** `supabase/functions/` 側のファイル（リポジトリ相対） */
  edge: string;
  /** 両側を import して突合するテスト。`null` は「止め具なし」を明示的に認めた状態 */
  pinnedBy: string | null;
  /** なぜ二重に持っているか。`pinnedBy: null` のときは、なぜ止め具が無くてよいか */
  reason: string;
}

/**
 * **宣言。空にしない。** 0件で緑になるのは検査の空洞そのものである。
 *
 * 新しく両側に同名の関数を作ったら、ここに足す。足さないと `undeclared` で赤くなる。
 * **足すときに「止め具は要るか」を必ず考えることになる。それがこの検査器の狙いである。**
 */
export const DUAL_IMPL_SPECS: DualImplSpec[] = [
  {
    fn: "retentionCutoff",
    src: "src/lib/retention/policy.ts",
    edge: "supabase/functions/_shared/retention.ts",
    pinnedBy: "tests/unit/retention-policy.test.ts",
    reason: "保持期間の方針。privacy §6 の正本。二重実装の**あるべき形**の実例",
  },
  {
    fn: "evaluateDeletion",
    src: "src/lib/retention/policy.ts",
    edge: "supabase/functions/_shared/retention.ts",
    pinnedBy: "tests/unit/retention-policy.test.ts",
    reason: "削除の門（数えてから消す）。消しすぎは取り返しがつかないので突合必須",
  },
  {
    fn: "percentile",
    src: "src/state/baselines.ts",
    edge: "supabase/functions/_shared/baseline-stats.ts",
    pinnedBy: "tests/unit/baseline-stats.test.ts",
    reason: "ベースラインの統計。ずれると検知の閾値が両側で変わる",
  },
  {
    fn: "isQuietHour",
    src: "src/act/quiet-hours.ts",
    edge: "supabase/functions/_shared/quiet-hours.ts",
    pinnedBy: "tests/unit/quiet-hours.test.ts",
    reason:
      "送信時刻の規則。2026-08-31 まで Edge 側が `deliver-alert/index.ts` に直書きで、" +
      "import できず突合テストを書けなかった。`_shared/quiet-hours.ts` に切り出して止め具を付けた",
  },
  {
    fn: "generateEventId",
    src: "src/ingest/csv-parser.ts",
    edge: "supabase/functions/_shared/event-id.ts",
    pinnedBy: null,
    reason:
      "冪等キー。Node の `createHash` と Web Crypto の必然的な差で、出力は同一（2026-08-31 実測）。" +
      "同期／非同期でシグネチャが違うため単純な突合が書けない。止め具は未着手",
  },
  {
    fn: "estimateTokens",
    src: "src/state/company-summary.ts",
    edge: "supabase/functions/state-memory-packet/index.ts",
    pinnedBy: null,
    reason:
      "トークン見積り。src 側・edge 側とも2箇所ずつあり、**同名で2つの意味を持つ**" +
      "（空文字を 0 とするか 1 とするか）。どちらが正しいかを決めるのが先",
  },
  {
    fn: "syncCalendarEvents",
    src: "src/app/auth/callback/google/route.ts",
    edge: "supabase/functions/sync-connections/index.ts",
    pinnedBy: null,
    reason:
      "初回取り込みと差分同期で**取得窓の起点が意図的に違う**（12ヶ月遡り / 前回同期以降）。" +
      "エンベロープの項目は同一（2026-08-31 実測）。単純な突合はできない",
  },
  {
    fn: "syncFreeeTransactions",
    src: "src/app/auth/callback/freee/route.ts",
    edge: "supabase/functions/sync-connections/index.ts",
    pinnedBy: null,
    reason: "`syncCalendarEvents` と同じ理由",
  },
  {
    fn: "unauthorized",
    src: "src/lib/auth/company.ts",
    edge: "supabase/functions/_shared/caller.ts",
    pinnedBy: null,
    reason: "401 を返すだけのヘルパ。挙動の一致に意味が無いので止め具を付けない",
  },
];

export type DualImplReason = "undeclared" | "dangling" | "missing-file" | "missing-pin";

export interface Finding {
  fn: string;
  reason: DualImplReason;
  detail: string;
}

const FN_PATTERN = /^[ \t]*(?:export[ \t]+)?(?:async[ \t]+)?function[ \t]+([A-Za-z0-9_$]+)/gm;

function listTsFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listTsFiles(full, acc);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) acc.push(full);
  }
  return acc;
}

/** ファイル群から「関数名 → 定義しているファイル」を作る */
export function collectFunctions(
  files: readonly string[],
  read: (p: string) => string,
): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const f of files) {
    for (const m of read(f).matchAll(FN_PATTERN)) {
      const name = m[1];
      const list = found.get(name) ?? [];
      // 同じファイル内の重複定義は数えない
      if (!list.includes(f)) list.push(f);
      found.set(name, list);
    }
  }
  return found;
}

/** 突合テストが両側を import しているか。`@edge/` と src 側の両方に触れていれば真 */
export function pinsBothSides(testSource: string): boolean {
  const touchesEdge = /@edge\/|supabase\/functions\//.test(testSource);
  const touchesSrc = /@\/|\.\.\/\.\.\/src\/|\.\.\/src\//.test(testSource);
  return touchesEdge && touchesSrc;
}

export function findViolations(
  specs: readonly DualImplSpec[],
  srcFns: ReadonlyMap<string, string[]>,
  edgeFns: ReadonlyMap<string, string[]>,
  read: (p: string) => string,
  exists: (p: string) => boolean,
): Finding[] {
  const findings: Finding[] = [];
  const declared = new Set(specs.map((s) => s.fn));

  // 1. 両側にあるのに宣言が無い（本命）
  for (const [fn, srcFiles] of srcFns) {
    if (!edgeFns.has(fn) || declared.has(fn)) continue;
    findings.push({
      fn,
      reason: "undeclared",
      detail:
        `${srcFiles[0]} と ${edgeFns.get(fn)![0]} の両方に定義がある。` +
        "DUAL_IMPL_SPECS に宣言し、止め具（両側を突合するテスト）の要否を決めること",
    });
  }

  for (const spec of specs) {
    // 2. 解消済みなのに宣言が残っている
    if (!srcFns.has(spec.fn) || !edgeFns.has(spec.fn)) {
      findings.push({
        fn: spec.fn,
        reason: "dangling",
        detail: "もう両側には無い。二重実装が解消されたので DUAL_IMPL_SPECS から消すこと",
      });
      continue;
    }

    // 3. 宣言したファイルが消えている（改名・移動）
    for (const p of [spec.src, spec.edge]) {
      if (!exists(p)) {
        findings.push({ fn: spec.fn, reason: "missing-file", detail: `${p} が存在しない` });
      }
    }

    // 4. 止め具を宣言しているのに、そのテストが両側を見ていない
    if (spec.pinnedBy) {
      if (!exists(spec.pinnedBy)) {
        findings.push({
          fn: spec.fn,
          reason: "missing-pin",
          detail: `${spec.pinnedBy} が存在しない`,
        });
      } else if (!pinsBothSides(read(spec.pinnedBy))) {
        findings.push({
          fn: spec.fn,
          reason: "missing-pin",
          detail: `${spec.pinnedBy} が両側（@edge/… と src 側）を import していない`,
        });
      }
    }
  }

  return findings;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  if (DUAL_IMPL_SPECS.length === 0) {
    console.error("check:dual-impl — 宣言が0件。検査対象が空のまま緑を返さない");
    process.exit(1);
  }

  const read = (p: string) => readFileSync(p, "utf8");
  const srcFiles = listTsFiles("src");
  const edgeFiles = listTsFiles(join("supabase", "functions"));

  if (srcFiles.length === 0 || edgeFiles.length === 0) {
    console.error("check:dual-impl — src / supabase/functions からファイルを読めなかった");
    process.exit(1);
  }

  const findings = findViolations(
    DUAL_IMPL_SPECS,
    collectFunctions(srcFiles, read),
    collectFunctions(edgeFiles, read),
    read,
    existsSync,
  );

  if (findings.length === 0) {
    const pinned = DUAL_IMPL_SPECS.filter((s) => s.pinnedBy).length;
    console.log(
      `check:dual-impl — 二重実装 ${DUAL_IMPL_SPECS.length}件すべて宣言どおり` +
        `（止め具あり ${pinned}件 / 明示的に無し ${DUAL_IMPL_SPECS.length - pinned}件、` +
        `走査 ${srcFiles.length + edgeFiles.length}ファイル）`,
    );
    process.exit(0);
  }

  console.error(`check:dual-impl — 二重実装の宣言と実物が合わない ${findings.length}件:`);
  console.error("");
  for (const f of findings) {
    console.error(`  [${f.reason}] ${f.fn}`);
    console.error(`      ${f.detail}`);
  }
  process.exit(1);
}
