/**
 * `check:cron-jobs` の突合ロジック（契約 スライスCD の後追い検査器）。
 *
 * **実物の `cron.job` だけを入力にすると、全部緑のとき検査器の故障が見えない。**
 * `.claude/rules/ci-coverage.md` が同じことを書いている。
 * ここは固定フィクスチャで、陰性コントロール3種が確かに赤になることを見る。
 */

import { describe, it, expect } from "vitest";
import { compareCronJobs, type CronJobDecl, type CronJobRow } from "../../scripts/check-cron-jobs";

const DECLARED: CronJobDecl[] = [
  { name: "sync-connections", schedule: "0 0,6,12,18 * * *" },
  { name: "dispatch-daily", schedule: "0 22 * * *" },
  { name: "dispatch-weekly", schedule: "0 23 * * 0" },
];

function rows(overrides: CronJobRow[] = []): CronJobRow[] {
  const base: CronJobRow[] = DECLARED.map((d) => ({ jobname: d.name, schedule: d.schedule }));
  return [...base, ...overrides];
}

describe("cron.job と宣言の突合", () => {
  it("宣言どおりなら findings は0件", () => {
    expect(compareCronJobs(DECLARED, rows())).toEqual([]);
  });

  it("順序が違っても一致とみなす（cron.job の並びに依存しない）", () => {
    const shuffled = [...rows()].reverse();
    expect(compareCronJobs(DECLARED, shuffled)).toEqual([]);
  });

  it("陰性コントロール: 宣言にあるジョブが cron.job に無い → missing", () => {
    const actual = rows().filter((r) => r.jobname !== "dispatch-weekly");
    const findings = compareCronJobs(DECLARED, actual);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "missing", name: "dispatch-weekly" });
  });

  it("陰性コントロール: cron.job にあるジョブが宣言に無い → undeclared", () => {
    // 手で張った、あるいは消し忘れた migration が残っている形
    const actual = rows([{ jobname: "leftover-job", schedule: "* * * * *" }]);
    const findings = compareCronJobs(DECLARED, actual);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "undeclared", name: "leftover-job" });
  });

  it("陰性コントロール: schedule が宣言と違う → schedule-mismatch", () => {
    // 同名ジョブは cron.schedule が上書きする。時刻だけ静かに変わる形がこれ
    const actual = rows().map((r) =>
      r.jobname === "dispatch-daily" ? { ...r, schedule: "0 21 * * *" } : r,
    );
    const findings = compareCronJobs(DECLARED, actual);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "schedule-mismatch",
      name: "dispatch-daily",
      expected: "0 22 * * *",
      actual: "0 21 * * *",
    });
  });

  it("複数の異常を同時に出す（最初の1件で止めない）", () => {
    const actual = rows([{ jobname: "leftover-job", schedule: "* * * * *" }])
      .filter((r) => r.jobname !== "sync-connections")
      .map((r) => (r.jobname === "dispatch-daily" ? { ...r, schedule: "0 21 * * *" } : r));

    const kinds = compareCronJobs(DECLARED, actual)
      .map((f) => f.kind)
      .sort();
    expect(kinds).toEqual(["missing", "schedule-mismatch", "undeclared"]);
  });
});
