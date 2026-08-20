import { describe, it, expect } from "vitest";
import {
  validateS2Columns,
  EVENTS_ALLOWLIST,
  runAllowlistCheck,
} from "../../scripts/check-allowlist";

describe("S2 allowlist schema check (B6, F1)", () => {
  it("events テーブルの許可カラムリストが spec/08 と一致する", () => {
    const expected = [
      "event_id",
      "company_id",
      "occurred_at",
      "period_start",
      "period_end",
      "ingested_at",
      "source",
      "event_type",
      "actor_ref",
      "entity_refs",
      "metrics",
      "sensitivity",
    ];
    expect(EVENTS_ALLOWLIST).toEqual(expected);
  });

  it("本文型カラムが存在する場合にエラーを返す", () => {
    const columnsWithBody = [...EVENTS_ALLOWLIST, "body"];
    const result = validateS2Columns(columnsWithBody, EVENTS_ALLOWLIST);
    expect(result.valid).toBe(false);
    expect(result.violations).toContain("body");
  });

  it("許可カラムのみの場合はパスする", () => {
    const result = validateS2Columns(EVENTS_ALLOWLIST, EVENTS_ALLOWLIST);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("token/secret を含むカラム名を検出する", () => {
    const columnsWithToken = [...EVENTS_ALLOWLIST, "access_token"];
    const result = validateS2Columns(columnsWithToken, EVENTS_ALLOWLIST);
    expect(result.valid).toBe(false);
  });
});

/**
 * S-5-4: CLI 入口が実DBを照会すること。
 *
 * 従来は `console.log` 1行で必ず exit 0 になっており、CLAUDE.md 絶対規則
 * 「S2テーブルに本文型カラムを追加しない」の機械的担保が存在しなかった。
 * 照会結果を注入できる形にして、緑になる条件・赤になる条件を両方固定する。
 */
describe("runAllowlistCheck — CLI 入口の判定", () => {
  it("実DBの列が allowlist と一致すれば ok", async () => {
    const result = await runAllowlistCheck(async () => [...EVENTS_ALLOWLIST]);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("実DBに本文型カラムが増えていたら fail する", async () => {
    const result = await runAllowlistCheck(async () => [...EVENTS_ALLOWLIST, "body"]);
    expect(result.ok).toBe(false);
    expect(result.violations).toContain("body");
  });

  it("列が1件も取れなかったら「一致」ではなく fail にする（空で緑を作らない）", async () => {
    const result = await runAllowlistCheck(async () => []);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-columns");
  });

  it("照会に失敗したら fail-closed（例外を緑に変えない）", async () => {
    const result = await runAllowlistCheck(async () => {
      throw new Error("SUPABASE_URL が未設定");
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("query-failed");
  });
});
