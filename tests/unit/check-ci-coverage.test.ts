import { describe, it, expect } from "vitest";
import {
  collectJobs,
  collectCheckInvocations,
  jobHasDeno,
  jobHasLiveDb,
  runCoverageCheck,
  type CheckDecl,
} from "../../scripts/check-ci-coverage";

/**
 * S-5-7 の陽性・陰性コントロール。
 *
 * **実物のワークフローだけを入力にすると、全部緑のとき検査器の故障が見えない。**
 * check:allowlist が1行 log で緑を返していた空洞と同型なので、
 * 固定フィクスチャで「壊れた配置を食わせたら赤を返す」ことを直接確かめる。
 *
 * 再現したい事故は2つ:
 *   #1 検査器はあるが CI に載っていない（deno check 28件）
 *   #3 ci.yml と deploy.yml の分担がずれている（deploy.yml の check:allowlist）
 */

const CI_YML = `
name: ci
on: [pull_request]
jobs:
  verify:
    steps:
      - uses: actions/checkout@v7
      - run: pnpm run check:db-errors
  integration:
    steps:
      - uses: supabase/setup-cli@v1
      - name: Start local Supabase
        run: supabase start
      - run: pnpm run check:allowlist
  edge-functions:
    steps:
      - uses: denoland/setup-deno@v2
      - run: pnpm run check:edge-types
`;

const DEPLOY_YML_CLEAN = `
name: deploy
on:
  push:
    branches: [main]
jobs:
  verify:
    steps:
      - run: pnpm typecheck && pnpm lint
`;

/** 2026-08-20 に外した実際の壊れた状態を再現する（#3）。 */
const DEPLOY_YML_BROKEN = `
name: deploy
on:
  push:
    branches: [main]
jobs:
  verify:
    steps:
      - run: pnpm typecheck && pnpm lint
      - run: pnpm run check:allowlist
`;

const DECLS: CheckDecl[] = [
  {
    id: "check-allowlist",
    script: "check:allowlist",
    file: "check-allowlist.ts",
    command: "pnpm run check:allowlist",
    requires: ["live-db"],
    must_run_in: ["ci.integration"],
  },
  {
    id: "check-db-errors",
    script: "check:db-errors",
    file: "check-db-error-handling.ts",
    command: "pnpm run check:db-errors",
    requires: [],
    must_run_in: ["ci.verify"],
  },
  {
    id: "check-edge-types",
    script: "check:edge-types",
    file: "check-edge-types.ts",
    command: "pnpm run check:edge-types",
    requires: ["deno"],
    must_run_in: ["ci.edge-functions"],
  },
];

const SCRIPTS = ["check:allowlist", "check:db-errors", "check:edge-types"];
const FILES = ["check-allowlist.ts", "check-db-error-handling.ts", "check-edge-types.ts"];

function check(
  workflows: Record<string, string>,
  decls = DECLS,
  packageScripts = SCRIPTS,
  scriptFiles = FILES,
) {
  return runCoverageCheck({ jobs: collectJobs(workflows), decls, packageScripts, scriptFiles });
}

describe("collectJobs — ワークフローを <file>.<job> に平坦化する", () => {
  it("複数ワークフローのジョブを全部拾う", () => {
    const jobs = collectJobs({ "ci.yml": CI_YML, "deploy.yml": DEPLOY_YML_CLEAN });
    expect(jobs.map((j) => j.key).sort()).toEqual([
      "ci.edge-functions",
      "ci.integration",
      "ci.verify",
      "deploy.verify",
    ]);
  });

  it("ジョブが無いワークフローでも落ちない", () => {
    expect(collectJobs({ "empty.yml": "name: empty\non: [push]\n" })).toEqual([]);
  });
});

describe("前提の判定", () => {
  const jobs = collectJobs({ "ci.yml": CI_YML });
  const byKey = (k: string) => jobs.find((j) => j.key === k)!;

  it("supabase start があるジョブだけ live-db と判定する", () => {
    expect(jobHasLiveDb(byKey("ci.integration"))).toBe(true);
    expect(jobHasLiveDb(byKey("ci.verify"))).toBe(false);
  });

  it("setup-deno があるジョブだけ deno と判定する", () => {
    expect(jobHasDeno(byKey("ci.edge-functions"))).toBe(true);
    expect(jobHasDeno(byKey("ci.verify"))).toBe(false);
  });
});

describe("陽性コントロール（正しい配置は緑）", () => {
  it("宣言どおりに載っていれば findings は 0件", () => {
    expect(check({ "ci.yml": CI_YML, "deploy.yml": DEPLOY_YML_CLEAN })).toEqual([]);
  });
});

describe("陰性コントロール #3 — 分担のずれ（deploy.yml の check:allowlist）", () => {
  it("live-db を持たないジョブで実行していたら forbidden を返す", () => {
    const findings = check({ "ci.yml": CI_YML, "deploy.yml": DEPLOY_YML_BROKEN });
    expect(findings).toContainEqual({
      kind: "forbidden",
      id: "check-allowlist",
      detail:
        "deploy.verify は requires: live-db を満たさないのに pnpm run check:allowlist を実行している",
    });
  });

  it("単純な集合包含では見逃す形であることを示す（ci.integration には載ったまま）", () => {
    const findings = check({ "ci.yml": CI_YML, "deploy.yml": DEPLOY_YML_BROKEN });
    // must_run_in は満たしているので missing は出ない。forbidden だけが出る
    expect(findings.filter((f) => f.kind === "missing")).toEqual([]);
    expect(findings.filter((f) => f.kind === "forbidden")).toHaveLength(1);
  });
});

describe("陰性コントロール #1 — 検査器が CI に載っていない（deno check 28件の形）", () => {
  it("must_run_in のジョブで走っていなければ missing を返す", () => {
    const withoutEdgeTypes = CI_YML.replace("      - run: pnpm run check:edge-types\n", "");
    const findings = check({ "ci.yml": withoutEdgeTypes });
    expect(findings).toContainEqual({
      kind: "missing",
      id: "check-edge-types",
      detail: "ci.edge-functions で pnpm run check:edge-types が走っていない",
    });
  });

  it("ジョブごと消えた場合は unknown-job を返す", () => {
    const findings = check({ "ci.yml": CI_YML.split("  edge-functions:")[0] });
    expect(findings).toContainEqual({
      kind: "unknown-job",
      id: "check-edge-types",
      detail: "must_run_in の ci.edge-functions が実在しない",
    });
  });
});

describe("宣言と package.json の両方向の集合差", () => {
  it("package.json にあるのに宣言に無ければ undeclared-script", () => {
    const findings = check({ "ci.yml": CI_YML }, DECLS, [...SCRIPTS, "check:newthing"]);
    expect(findings).toContainEqual({
      kind: "undeclared-script",
      id: "check:newthing",
      detail: "package.json にあるが宣言に無い",
    });
  });

  it("宣言にあるのに package.json に無ければ dangling-declaration", () => {
    const findings = check({ "ci.yml": CI_YML }, DECLS, ["check:allowlist", "check:db-errors"]);
    expect(findings).toContainEqual({
      kind: "dangling-declaration",
      id: "check:edge-types",
      detail: "宣言にあるが package.json に無い",
    });
  });

  it("check: 接頭辞でないスクリプトは対象外（typecheck 等を巻き込まない）", () => {
    const findings = check({ "ci.yml": CI_YML }, DECLS, [...SCRIPTS, "typecheck", "lint"]);
    expect(findings.filter((f) => f.kind === "undeclared-script")).toEqual([]);
  });
});

describe("ワークフローへの直書き検出", () => {
  it("CI で走っているのに宣言に無ければ undeclared-in-workflow", () => {
    const injected = CI_YML.replace(
      "      - run: pnpm run check:db-errors",
      "      - run: pnpm run check:db-errors\n      - run: pnpm run check:sneaky",
    );
    const findings = check({ "ci.yml": injected });
    expect(findings).toContainEqual({
      kind: "undeclared-in-workflow",
      id: "check:sneaky",
      detail: "CI で走っているが宣言に無い",
    });
  });

  it("collectCheckInvocations は複数行 run からも拾う", () => {
    const jobs = collectJobs({
      "ci.yml": `
name: ci
jobs:
  verify:
    steps:
      - run: |
          set -euo pipefail
          pnpm run check:allowlist
          pnpm run check:schema
`,
    });
    expect([...collectCheckInvocations(jobs)].sort()).toEqual(["check:allowlist", "check:schema"]);
  });
});

describe("宣言自身の整合", () => {
  it("must_run_in のジョブが requires を満たさなければ inconsistent-declaration", () => {
    const bad: CheckDecl[] = [
      {
        id: "check-allowlist",
        script: "check:allowlist",
        command: "pnpm run check:allowlist",
        requires: ["live-db"],
        must_run_in: ["ci.verify"], // verify に live-db は無い
      },
    ];
    const findings = check({ "ci.yml": CI_YML }, bad, ["check:allowlist"]);
    expect(findings).toContainEqual({
      kind: "inconsistent-declaration",
      id: "check-allowlist",
      detail: "ci.verify は requires: live-db を満たさないのに must_run_in に入っている",
    });
  });
});

describe("scripts/ の実ファイルとの両方向の集合差（残る穴をもう一段狭める）", () => {
  it("scripts/ にあるのに宣言に無ければ undeclared-script-file", () => {
    const findings = check({ "ci.yml": CI_YML }, DECLS, SCRIPTS, [...FILES, "check-orphan.ts"]);
    expect(findings).toContainEqual({
      kind: "undeclared-script-file",
      id: "check-orphan.ts",
      detail: "scripts/ にあるが宣言に無い",
    });
  });

  it("package.json に登録せずにファイルだけ作った場合も捕まる", () => {
    // package.json には出ないので undeclared-script は出ない。ファイル側だけで捕まえる
    const findings = check({ "ci.yml": CI_YML }, DECLS, SCRIPTS, [...FILES, "check-orphan.ts"]);
    expect(findings.filter((f) => f.kind === "undeclared-script")).toEqual([]);
    expect(findings.filter((f) => f.kind === "undeclared-script-file")).toHaveLength(1);
  });

  it("宣言にあるのに scripts/ に無ければ dangling-file", () => {
    const findings = check({ "ci.yml": CI_YML }, DECLS, SCRIPTS, [
      "check-allowlist.ts",
      "check-db-error-handling.ts",
    ]);
    expect(findings).toContainEqual({
      kind: "dangling-file",
      id: "check-edge-types.ts",
      detail: "宣言にあるが scripts/ に無い",
    });
  });
});

describe("must_not_run_in — requires が空の検査器の配置禁止", () => {
  it("requires が空でも明示すれば forbidden を返す", () => {
    const decls: CheckDecl[] = [
      {
        id: "check-db-errors",
        script: "check:db-errors",
        file: "check-db-error-handling.ts",
        command: "pnpm run check:db-errors",
        requires: [],
        must_run_in: ["ci.verify"],
        must_not_run_in: ["deploy.verify"],
      },
    ];
    const broken = `
name: deploy
jobs:
  verify:
    steps:
      - run: pnpm run check:db-errors
`;
    const findings = check(
      { "ci.yml": CI_YML, "deploy.yml": broken },
      decls,
      ["check:db-errors"],
      ["check-db-error-handling.ts"],
    );
    expect(findings).toContainEqual({
      kind: "forbidden",
      id: "check-db-errors",
      detail: "deploy.verify は must_not_run_in なのに pnpm run check:db-errors を実行している",
    });
  });
});
