/**
 * `check:deletion-coverage` の陽性・陰性コントロール（発注3 の 3-2）。
 *
 * **実物の手順書だけを入力にすると、全部緑のとき検査器の故障が見えない。**
 * `.claude/rules/ci-coverage.md`「変更時の作法」と同じ理由で、
 * 固定フィクスチャでの陰性コントロールを必ず持つ。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  compareDeletionCoverage,
  parseRunbookDeletes,
  loadDeclaration,
} from "../../scripts/check-deletion-coverage";

/** 2026-09-03 時点の実物。`company_id` を持つテーブル11件。 */
const WITH_COMPANY_ID = new Set([
  "baselines",
  "budget_usage",
  "company_summary",
  "connections",
  "delivery_log",
  "entities",
  "events",
  "findings",
  "known_explanations",
  "misjudgments",
  "narratives",
]);

describe("parseRunbookDeletes", () => {
  it("delete from public.<table> を抜く", () => {
    const md = [
      "delete from public.events        where company_id in (select id from target);",
      "delete from public.entities where company_id in (...);",
      "DELETE FROM public.findings WHERE company_id IN (...);",
    ].join("\n");
    expect([...parseRunbookDeletes(md)].sort()).toEqual(["entities", "events", "findings"]);
  });

  it("public. が付かない delete は拾わない（他スキーマを消したことにしない）", () => {
    expect(parseRunbookDeletes("delete from auth.users where id = '...';").size).toBe(0);
  });
});

describe("compareDeletionCoverage", () => {
  const deleted = new Set(WITH_COMPANY_ID);

  it("陽性: すべて列挙されていれば findings は0件", () => {
    expect(compareDeletionCoverage(WITH_COMPANY_ID, deleted, [])).toEqual([]);
  });

  it("陰性1: 列挙から1件消すと uncovered で赤くなる", () => {
    const minusOne = new Set([...deleted].filter((t) => t !== "known_explanations"));
    expect(compareDeletionCoverage(WITH_COMPANY_ID, minusOne, [])).toEqual([
      { kind: "uncovered", table: "known_explanations" },
    ]);
  });

  it("陰性2: company_id を持つテーブルが1つ増えると uncovered で赤くなる", () => {
    const plusOne = new Set([...WITH_COMPANY_ID, "new_table_with_company_id"]);
    expect(compareDeletionCoverage(plusOne, deleted, [])).toEqual([
      { kind: "uncovered", table: "new_table_with_company_id" },
    ]);
  });

  it("keep に**残す理由**つきで挙げれば例外として通る", () => {
    const plusOne = new Set([...WITH_COMPANY_ID, "new_table_with_company_id"]);
    const keep = [{ table: "new_table_with_company_id", reason: "（例）保存義務のある記録" }];
    expect(compareDeletionCoverage(plusOne, deleted, keep)).toEqual([]);
  });

  it("手順書が消しているのに company_id が無ければ stale-delete", () => {
    const shrunk = new Set([...WITH_COMPANY_ID].filter((t) => t !== "misjudgments"));
    expect(compareDeletionCoverage(shrunk, deleted, [])).toEqual([
      { kind: "stale-delete", table: "misjudgments" },
    ]);
  });

  it("keep が実物より古ければ keep-without-column", () => {
    const keep = [{ table: "gone_table", reason: "（例）古い宣言" }];
    expect(compareDeletionCoverage(WITH_COMPANY_ID, deleted, keep)).toEqual([
      { kind: "keep-without-column", table: "gone_table" },
    ]);
  });

  it("3種を同時に出す（最初の1件で止めない）", () => {
    const actual = new Set([...WITH_COMPANY_ID, "added"]);
    actual.delete("misjudgments");
    const keep = [{ table: "gone_table", reason: "（例）古い宣言" }];
    expect(compareDeletionCoverage(actual, deleted, keep).map((f) => f.kind).sort()).toEqual([
      "keep-without-column",
      "stale-delete",
      "uncovered",
    ]);
  });
});

describe("実物との突合（宣言と手順書は実ファイルを読む）", () => {
  it("宣言が指す手順書から delete 文を読める（書式が変わったら気づく）", () => {
    const decl = loadDeclaration("docs/checklists/deletion-coverage.yml");
    const deleted = parseRunbookDeletes(readFileSync(decl.runbook, "utf8"));
    expect(deleted.size).toBeGreaterThan(0);
    // 2026-09-03 に足した1件。落ちたら手順書から消えている
    expect(deleted.has("known_explanations")).toBe(true);
  });

  it("実物の手順書が、company_id を持つ11件をすべて消している", () => {
    const decl = loadDeclaration("docs/checklists/deletion-coverage.yml");
    const deleted = parseRunbookDeletes(readFileSync(decl.runbook, "utf8"));
    expect(compareDeletionCoverage(WITH_COMPANY_ID, deleted, decl.keep)).toEqual([]);
  });
});
