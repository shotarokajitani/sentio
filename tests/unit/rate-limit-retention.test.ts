/**
 * `api_rate_limits` の古い窓を消す方針（2026-09-13 の点検・PR-2b）。
 *
 * 規律は events の削除と同じ: **既定は数えるだけ・数えられなければ消さない・上限を超えたら消さない。**
 */
import { describe, it, expect } from "vitest";
import {
  RATE_LIMIT_RETENTION_DAYS,
  planRateLimitPurge,
  rateLimitCutoff,
} from "@edge/_shared/rate-limit-retention";

describe("消す境界", () => {
  it("2日より前の窓を消す", () => {
    expect(RATE_LIMIT_RETENTION_DAYS).toBe(2);
    expect(rateLimitCutoff(new Date("2026-09-14T03:00:00Z")).toISOString()).toBe(
      "2026-09-12T03:00:00.000Z",
    );
  });

  it("**陰性**: 境界は最長の窓（1日）より後ろにある（数えている最中の窓を消さない）", () => {
    const now = new Date("2026-09-14T03:00:00Z");
    const oneDayAgo = now.getTime() - 24 * 60 * 60 * 1000;
    expect(rateLimitCutoff(now).getTime()).toBeLessThan(oneDayAgo);
  });
});

describe("消すかどうか", () => {
  it("**陰性**: dry_run なら数えるだけで消さない", () => {
    expect(planRateLimitPurge({ counted: 12, max: 100, dryRun: true })).toEqual({
      decision: "dry_run",
      count: 12,
    });
  });

  it("dry_run でなければ消す", () => {
    expect(planRateLimitPurge({ counted: 12, max: 100, dryRun: false })).toEqual({
      decision: "deleted",
      count: 12,
    });
  });

  it("**陰性**: 数えられなければ消さない（uncounted）", () => {
    expect(planRateLimitPurge({ counted: null, max: 100, dryRun: false })).toEqual({
      decision: "blocked",
      reason: "uncounted",
      count: 0,
    });
  });

  it("**陰性**: 上限を超えたら消さない（over-limit）", () => {
    expect(planRateLimitPurge({ counted: 101, max: 100, dryRun: false })).toEqual({
      decision: "blocked",
      reason: "over-limit",
      count: 101,
    });
  });

  it("0件なら何もしない", () => {
    expect(planRateLimitPurge({ counted: 0, max: 100, dryRun: false })).toEqual({
      decision: "nothing",
      count: 0,
    });
  });
});
