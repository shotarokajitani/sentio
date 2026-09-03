/// <reference types="node" />

/**
 * cron ジョブの「宣言 × 実物」突合（契約 スライスCD の後追い検査器）。
 *
 * **なぜ必要か。**
 * migration が適用されたことは CI のログで見えるが、**`cron.job` に何が入っているか**は
 * 誰も見ていなかった。`cron.schedule` は**同名ジョブを上書きする**仕様なので、
 * 将来の migration が名前を再利用すれば、既存のジョブは静かに置き換わる。
 * スケジュールが契約からずれても気づく経路が無い。
 * `.claude/rules/ci-coverage.md` の「検査器はあるが CI で落ちない」3例と同じ形になる。
 *
 * 「一度だけ Dashboard で見る」「一時的に確認する」では、次に壊れたときに誰も気づかない。
 * **恒久の検査器として CI に載せる。**
 *
 * 正本は `docs/checklists/cron-jobs.yml`。
 * 実DBが要るので `ci.integration` に載せる（`verify` には載せられない）。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

export interface CronJobDecl {
  name: string;
  schedule: string;
}

export interface CronJobRow {
  jobname: string;
  schedule: string;
}

export type CronFindingKind = "missing" | "undeclared" | "schedule-mismatch";

export interface CronFinding {
  kind: CronFindingKind;
  name: string;
  /** schedule-mismatch のときのみ */
  expected?: string;
  actual?: string;
}

/**
 * 突合は**両方向**に取る。
 *
 * - `missing`: 宣言にあるのに `cron.job` に無い（migration が当たっていない・消された）
 * - `undeclared`: `cron.job` にあるのに宣言に無い（手で張った・消し忘れた migration がある）
 * - `schedule-mismatch`: 名前は合うが時刻が違う（同名上書きで静かに変わった形）
 *
 * **最初の1件で止めない。** 3種を同時に出す。1つ直すたびに CI を回し直すのは
 * 検査器の使い勝手として悪く、結局まとめて見たくなる。
 */
export function compareCronJobs(declared: CronJobDecl[], actual: CronJobRow[]): CronFinding[] {
  const findings: CronFinding[] = [];
  const actualByName = new Map(actual.map((r) => [r.jobname, r]));
  const declaredNames = new Set(declared.map((d) => d.name));

  for (const decl of declared) {
    const row = actualByName.get(decl.name);
    if (!row) {
      findings.push({ kind: "missing", name: decl.name });
      continue;
    }
    if (row.schedule !== decl.schedule) {
      findings.push({
        kind: "schedule-mismatch",
        name: decl.name,
        expected: decl.schedule,
        actual: row.schedule,
      });
    }
  }

  for (const row of actual) {
    if (!declaredNames.has(row.jobname)) {
      findings.push({ kind: "undeclared", name: row.jobname });
    }
  }

  return findings;
}

export function loadDeclaration(path = "docs/checklists/cron-jobs.yml"): CronJobDecl[] {
  const doc = parse(readFileSync(path, "utf8")) as { jobs?: CronJobDecl[] };
  if (!doc?.jobs || doc.jobs.length === 0) {
    throw new Error(`${path} に jobs が無い。宣言が空だと全部 undeclared になり検査が壊れる`);
  }
  return doc.jobs.map((j) => ({ name: j.name, schedule: j.schedule }));
}

/**
 * `cron.job` を psql で1回引く。`check:allowlist` / `check:schema` と同じ経路
 * （`scripts/live-schema.ts` の理由書きを参照）。依存を増やさないために psql を使う。
 */
export function fetchCronJobs(dbUrl = process.env.SUPABASE_DB_URL): CronJobRow[] {
  if (!dbUrl) {
    throw new Error(
      "SUPABASE_DB_URL が未設定のため cron.job を照会できない。" +
        "ローカルでは `supabase status -o env` の DB_URL を渡すこと",
    );
  }

  // 区切りはタブ。SQL 側に '\t' と書くと2文字になる（live-schema.ts の実測メモと同じ罠）
  const sql = "SELECT jobname, schedule FROM cron.job ORDER BY jobname";

  const out = execFileSync("psql", [dbUrl, "-A", "-t", "-F", "\t", "-c", sql], {
    encoding: "utf8",
  });

  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [jobname, schedule] = line.split("\t");
      return { jobname, schedule };
    });
}

function main(): never {
  const declared = loadDeclaration();
  const actual = fetchCronJobs();
  const findings = compareCronJobs(declared, actual);

  if (findings.length === 0) {
    console.log(
      `check:cron-jobs — cron.job ${actual.length}件が宣言と一致` +
        `（${declared.map((d) => d.name).join(" / ")}）`,
    );
    process.exit(0);
  }

  console.error(`check:cron-jobs — cron ジョブの不一致 ${findings.length}件:`);
  for (const f of findings) {
    if (f.kind === "missing") {
      console.error(`  [missing] ${f.name}: 宣言されているが cron.job に無い`);
    } else if (f.kind === "undeclared") {
      console.error(
        `  [undeclared] ${f.name}: cron.job にあるが docs/checklists/cron-jobs.yml に無い`,
      );
    } else {
      console.error(
        `  [schedule-mismatch] ${f.name}: 宣言 "${f.expected}" / 実物 "${f.actual}"`,
      );
    }
  }
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
