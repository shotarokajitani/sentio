/// <reference types="node" />

/**
 * Edge Function の「配る」「消す」「知らないものが居る」を突き合わせる（発注 F）。
 *
 * ## なぜ作ったか
 *
 * **本番に、リポジトリのどこにも無い関数が20本 ACTIVE で残っていた**
 * （2026-09-10・`list_edge_functions` の実測）。`deploy.yml` は「配る」しかせず、
 * 配っていない関数が本番に残っていても誰も見ない。`check:caller-guard` も
 * `supabase/functions/` 配下しか走査しないので、**リポジトリの外は全部が射程外**だった。
 *
 * 残っていたものに `stripe-webhook` / `create-checkout` / `create-portal-link` /
 * `process-answer` が含まれる。**課金と入力の口が、誰も見ていない実装で開いていた。**
 *
 * ## 2つの層に分かれている
 *
 *   ローカル層  宣言 × `supabase/functions/` 配下 × `deploy.yml` の Deploy 段
 *   本番層      宣言 × 本番の一覧（`SUPABASE_FUNCTIONS_LIVE` があるときだけ）
 *
 * ローカル層は PR の CI（`verify`）で走る。本番層は `deploy` ジョブでしか
 * 引けないので、一覧を渡されたときだけ見る。**引けないことを「一致した」と読まない**
 * ように、渡されなければ本番層は「未実行」と明示して出す。
 */

import { readdirSync, readFileSync } from "node:fs";
import { parse } from "yaml";

const CHECKLIST = "docs/checklists/edge-functions.yml";
const FUNCTIONS_DIR = "supabase/functions";
const DEPLOY_WORKFLOW = ".github/workflows/deploy.yml";

export interface EdgeDeclaration {
  deploy: string[];
  ci_only: string[];
  remove: string[];
}

export function loadEdgeDeclaration(path = CHECKLIST): EdgeDeclaration {
  const doc = parse(readFileSync(path, "utf8")) as Partial<EdgeDeclaration>;
  if (!doc.deploy?.length || !doc.ci_only?.length || !doc.remove?.length) {
    // **空の一覧を「一致した」と読ませない。** fail-closed
    throw new Error(`${path}: deploy / ci_only / remove のいずれかが空である`);
  }
  return doc as EdgeDeclaration;
}

/** `supabase/functions/` 配下のディレクトリ（`_shared` は関数ではない） */
export function functionDirs(dir = FUNCTIONS_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "_shared")
    .map((e) => e.name)
    .sort();
}

/** `deploy.yml` が実際に配っている slug */
export function deployedSlugs(source: string): string[] {
  return [...source.matchAll(/supabase functions deploy ([\w-]+)/g)].map((m) => m[1]).sort();
}

const diff = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));

export function checkLocal(
  decl: EdgeDeclaration,
  dirs: string[],
  deployed: string[],
): string[] {
  const findings: string[] = [];
  const known = [...decl.deploy, ...decl.ci_only];

  for (const d of diff(dirs, known)) {
    findings.push(`[undeclared-dir] ${FUNCTIONS_DIR}/${d} があるのに宣言に無い`);
  }
  for (const d of diff(known, dirs)) {
    findings.push(`[dangling] 宣言に ${d} があるのに ${FUNCTIONS_DIR}/${d} が無い`);
  }
  for (const d of diff(decl.deploy, deployed)) {
    findings.push(`[not-deployed] 宣言では配るはずの ${d} が ${DEPLOY_WORKFLOW} に無い`);
  }
  for (const d of diff(deployed, decl.deploy)) {
    findings.push(`[undeclared-deploy] ${DEPLOY_WORKFLOW} が ${d} を配るのに宣言に無い`);
  }
  // **配るものと消すものが重ならないこと。** 配った直後に消すと本番が壊れる
  for (const d of decl.remove.filter((x) => known.includes(x))) {
    findings.push(`[conflict] ${d} が deploy / ci_only と remove の両方にある`);
  }
  return findings;
}

/** 本番に居る slug を、宣言と突き合わせる。**知らないものが居たら赤にする** */
export function checkLive(decl: EdgeDeclaration, live: string[]): string[] {
  const allowed = [...decl.deploy, ...decl.remove];
  return diff(live, allowed).map(
    (s) => `[unknown-in-production] 本番に ${s} が居るが、配る一覧にも消す一覧にも無い`,
  );
}

function main() {
  const decl = loadEdgeDeclaration();
  const findings = checkLocal(
    decl,
    functionDirs(),
    deployedSlugs(readFileSync(DEPLOY_WORKFLOW, "utf8")),
  );

  // 本番の一覧は `deploy` ジョブでしか引けない。**引けないことを黙って緑にしない**
  const liveRaw = process.env.SUPABASE_FUNCTIONS_LIVE?.trim();
  if (liveRaw) {
    const live = liveRaw.split(/\s+/).filter(Boolean).sort();
    findings.push(...checkLive(decl, live));
    console.log(`本番の一覧 ${live.length}件を突合した`);
  } else {
    console.log(
      "本番の一覧は未取得（SUPABASE_FUNCTIONS_LIVE が無い）。**本番との突合は未実行**",
    );
  }

  if (findings.length > 0) {
    console.error(`\ncheck:edge-functions — 不一致 ${findings.length}件:\n`);
    for (const f of findings) console.error(`  ${f}`);
    process.exit(1);
  }

  console.log(
    `check:edge-functions — 配る ${decl.deploy.length}本 / CI 専用 ${decl.ci_only.length}本 / ` +
      `消す ${decl.remove.length}本が宣言どおり`,
  );
}

if (process.argv[1] && process.argv[1].endsWith("check-edge-functions.ts")) {
  // `deploy.yml` の削除段が消す slug を引くのに使う。
  // **一覧を2か所に書かない**——ワークフローに直書きすると宣言とずれる
  if (process.argv.includes("--list-remove")) {
    console.log(loadEdgeDeclaration().remove.join(" "));
  } else {
    main();
  }
}
