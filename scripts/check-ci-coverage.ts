/// <reference types="node" />

/**
 * S-5-7: 「検査器はあるが CI で落ちない」を機械的に検出する。
 *
 * 同型の穴が3度出た:
 *   1. deno check 28件 — 検査器はあるが **CI に載っていなかった**
 *   2. S-5-1 check:schema — CI で走って赤なのに完了報告された
 *   3. deploy.yml の check:allowlist — ci.yml と deploy.yml の **分担がずれていた**
 *
 * このスクリプトが担うのは #1 と #3 である。どちらも **CI が赤にならない**ことが
 * 問題の本体なので、run の色を見る監視では原理的に届かない。
 * #2（赤を読まずに完了報告）は運用側（CLAUDE.md「CI監視の定型化」）の担当で、
 * ここでは捕まえられない。守れない範囲は `.claude/rules/ci-coverage.md` に明記する。
 *
 * `yaml` を devDependency に入れているのは、ワークフローを正規表現で読むと
 * **この検査器自身が壊れる**ためである（検査器が静かに空になる事故は
 * check:allowlist が1行 log で緑を返していた件で既に踏んでいる）。
 * 実行時バンドルには乗せない。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

export type Requirement = "live-db" | "deno";

export interface CheckDecl {
  id: string;
  script?: string;
  /** scripts/ 配下のファイル名。scripts/check-*.ts との集合差を取るのに使う。 */
  file?: string;
  command: string;
  contract?: string;
  requires?: Requirement[];
  must_run_in: string[];
  /** requires からは導出できない配置禁止を明示する（requires が空の検査器向け）。 */
  must_not_run_in?: string[];
  note?: string;
}

export interface WorkflowStep {
  run?: string;
  uses?: string;
}

/** `<ワークフローのファイル名（拡張子なし）>.<ジョブ名>` をキーにしたジョブ1件。 */
export interface WorkflowJob {
  key: string;
  steps: WorkflowStep[];
}

export type FindingKind =
  | "missing"
  | "forbidden"
  | "unknown-job"
  | "inconsistent-declaration"
  | "undeclared-in-workflow"
  | "undeclared-script"
  | "dangling-declaration"
  | "undeclared-script-file"
  | "dangling-file";

export interface Finding {
  kind: FindingKind;
  id: string;
  detail: string;
}

/** ジョブが実DBを持つか（`supabase start` を含むステップがあるか）。 */
export function jobHasLiveDb(job: WorkflowJob): boolean {
  return job.steps.some((s) => (s.run ?? "").includes("supabase start"));
}

/** ジョブが Deno を持つか（setup-deno を使っているか）。 */
export function jobHasDeno(job: WorkflowJob): boolean {
  return job.steps.some((s) => (s.uses ?? "").startsWith("denoland/setup-deno"));
}

function satisfies(job: WorkflowJob, req: Requirement): boolean {
  return req === "live-db" ? jobHasLiveDb(job) : jobHasDeno(job);
}

/** そのジョブでコマンドが実行されているか。 */
export function jobRuns(job: WorkflowJob, command: string): boolean {
  return job.steps.some((s) => (s.run ?? "").includes(command));
}

/** ワークフローの YAML 群を `<file>.<job>` 単位に平坦化する。 */
export function collectJobs(workflows: Record<string, string>): WorkflowJob[] {
  const jobs: WorkflowJob[] = [];

  for (const [fileName, source] of Object.entries(workflows)) {
    const base = fileName.replace(/\.ya?ml$/, "");
    const doc = parseYaml(source) as { jobs?: Record<string, { steps?: WorkflowStep[] }> };
    for (const [jobName, job] of Object.entries(doc?.jobs ?? {})) {
      jobs.push({ key: `${base}.${jobName}`, steps: job?.steps ?? [] });
    }
  }

  return jobs;
}

/** ワークフローの run から `pnpm run check:*` を全部拾う。 */
export function collectCheckInvocations(jobs: WorkflowJob[]): Set<string> {
  const found = new Set<string>();
  for (const job of jobs) {
    for (const step of job.steps) {
      const pattern = /pnpm run (check:[a-z0-9-]+)/g;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(step.run ?? "")) !== null) found.add(m[1]);
    }
  }
  return found;
}

export interface CoverageInput {
  jobs: WorkflowJob[];
  decls: CheckDecl[];
  /** package.json の scripts のキー一覧。 */
  packageScripts: string[];
  /** scripts/ 配下の check-*.ts のファイル名一覧。 */
  scriptFiles: string[];
}

/**
 * 配置の照合。判定は7種類。
 *
 * - `missing`  must_run_in のジョブで走っていない（＝ #1 の形）
 * - `forbidden`  前提を満たさないジョブで走っている（＝ #3 の形）
 * - `unknown-job`  must_run_in が実在しないジョブを指している
 * - `inconsistent-declaration`  must_run_in のジョブが requires を満たさない
 * - `undeclared-in-workflow`  CI で走っているのに宣言に無い
 * - `undeclared-script`  package.json の check:* が宣言に無い（宣言への書き忘れ）
 * - `dangling-declaration`  宣言が実在しない script を指している
 */
export function runCoverageCheck(input: CoverageInput): Finding[] {
  const { jobs, decls, packageScripts, scriptFiles } = input;
  const findings: Finding[] = [];
  const jobByKey = new Map(jobs.map((j) => [j.key, j]));

  for (const decl of decls) {
    const requires = decl.requires ?? [];

    for (const key of decl.must_run_in) {
      const job = jobByKey.get(key);
      if (!job) {
        findings.push({
          kind: "unknown-job",
          id: decl.id,
          detail: `must_run_in の ${key} が実在しない`,
        });
        continue;
      }
      if (!jobRuns(job, decl.command)) {
        findings.push({
          kind: "missing",
          id: decl.id,
          detail: `${key} で ${decl.command} が走っていない`,
        });
      }
      for (const req of requires) {
        if (!satisfies(job, req)) {
          findings.push({
            kind: "inconsistent-declaration",
            id: decl.id,
            detail: `${key} は requires: ${req} を満たさないのに must_run_in に入っている`,
          });
        }
      }
    }

    // 明示された配置禁止。requires が空の検査器はここでしか止められない
    for (const key of decl.must_not_run_in ?? []) {
      const job = jobByKey.get(key);
      if (job && jobRuns(job, decl.command)) {
        findings.push({
          kind: "forbidden",
          id: decl.id,
          detail: `${key} は must_not_run_in なのに ${decl.command} を実行している`,
        });
      }
    }

    // 前提を満たさないジョブで走っていたら禁止。
    // 「移設漏れ」ではなく「前提条件の不成立」として検出するので、
    // 将来 deploy.yml に check:schema を足した場合も同じ規則で捕まる
    for (const job of jobs) {
      if (!jobRuns(job, decl.command)) continue;
      for (const req of requires) {
        if (!satisfies(job, req)) {
          findings.push({
            kind: "forbidden",
            id: decl.id,
            detail: `${job.key} は requires: ${req} を満たさないのに ${decl.command} を実行している`,
          });
        }
      }
    }
  }

  // 宣言と package.json の両方向の集合差。
  // 「宣言への書き忘れ」を人間の注意力に委ねない
  const declaredScripts = new Set(decls.map((d) => d.script).filter((s): s is string => !!s));
  for (const script of packageScripts.filter((s) => s.startsWith("check:"))) {
    if (!declaredScripts.has(script)) {
      findings.push({
        kind: "undeclared-script",
        id: script,
        detail: `package.json にあるが宣言に無い`,
      });
    }
  }
  for (const script of declaredScripts) {
    if (!packageScripts.includes(script)) {
      findings.push({
        kind: "dangling-declaration",
        id: script,
        detail: `宣言にあるが package.json に無い`,
      });
    }
  }

  // scripts/ の実ファイルとの両方向の集合差。
  // 「package.json に登録せずに検査器ファイルだけ作った」を捕まえる。
  // これで残る穴は「検査器を scripts/check-*.ts 以外の場所に置いた」場合だけになる
  const declaredFiles = new Set(decls.map((d) => d.file).filter((f): f is string => !!f));
  for (const file of scriptFiles) {
    if (!declaredFiles.has(file)) {
      findings.push({
        kind: "undeclared-script-file",
        id: file,
        detail: `scripts/ にあるが宣言に無い`,
      });
    }
  }
  for (const file of declaredFiles) {
    if (!scriptFiles.includes(file)) {
      findings.push({ kind: "dangling-file", id: file, detail: `宣言にあるが scripts/ に無い` });
    }
  }

  // CI で走っているのに宣言に無いもの（誰かがワークフローに直書きした検査器）
  for (const invoked of collectCheckInvocations(jobs)) {
    if (!declaredScripts.has(invoked)) {
      findings.push({
        kind: "undeclared-in-workflow",
        id: invoked,
        detail: `CI で走っているが宣言に無い`,
      });
    }
  }

  return findings;
}

const WORKFLOW_DIR = ".github/workflows";
const DECL_PATH = "docs/checklists/ci-coverage.yml";

export function readWorkflows(dir = WORKFLOW_DIR): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    if (!/\.ya?ml$/.test(name)) continue;
    out[name] = readFileSync(join(dir, name), "utf8");
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const workflows = readWorkflows();
  const jobs = collectJobs(workflows);
  const decls =
    (parseYaml(readFileSync(DECL_PATH, "utf8")) as { checks: CheckDecl[] }).checks ?? [];
  const packageScripts = Object.keys(
    (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> })
      .scripts,
  );

  // 対象0件で緑になるのは検査の空洞そのもの（check:allowlist と同型）なので fail させる
  if (jobs.length === 0) {
    console.error(`check:ci-coverage — ${WORKFLOW_DIR} からジョブを1件も抽出できなかった`);
    console.error("検査対象が空のまま緑を返さない。ワークフローの書式変更を疑うこと。");
    process.exit(1);
  }
  if (decls.length === 0) {
    console.error(`check:ci-coverage — ${DECL_PATH} の宣言が0件`);
    console.error("宣言が空なら照合は常に緑になる。空を緑にしない。");
    process.exit(1);
  }

  const scriptFiles = readdirSync("scripts").filter((n) => /^check-.*.ts$/.test(n));

  const findings = runCoverageCheck({ jobs, decls, packageScripts, scriptFiles });

  if (findings.length === 0) {
    console.log(
      `check:ci-coverage — 検査器 ${decls.length}件がすべて宣言どおりのジョブに載っている（ジョブ ${jobs.length}件を走査）`,
    );
    process.exit(0);
  }

  console.error(`check:ci-coverage — 配置の不一致 ${findings.length}件:`);
  console.error("");
  for (const f of findings) console.error(`  [${f.kind}] ${f.id}: ${f.detail}`);
  console.error("");
  console.error(`宣言の正本は ${DECL_PATH}。配置を変えたら宣言も直すこと。`);
  process.exit(1);
}
