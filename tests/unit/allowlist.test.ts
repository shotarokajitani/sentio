import { describe, it, expect } from "vitest";
import {
  validateS2Columns,
  EVENTS_ALLOWLIST,
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
