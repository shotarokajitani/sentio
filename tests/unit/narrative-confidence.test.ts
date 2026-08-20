import { describe, it, expect } from "vitest";
import { decayedConfidence, HALF_LIFE_DAYS } from "@edge/_shared/narrative-confidence";

/**
 * S-1-3 / `.claude/rules/state.md`「narrativesのconfidenceは時間減衰。訂正dialogueで即時減算」。
 *
 * **修復前、減衰関数は定義されていたが1度も呼ばれていなかった**（デッドコード）。
 * しかも実在しない列 `updated_at` を引数に取る形だったため、呼んでも動かなかった。
 * 「時間減衰がある」は仕様上の主張としてだけ存在し、実体が無かった。
 */

const day = 24 * 60 * 60 * 1000;
const at = (iso: string) => new Date(iso);

describe("decayedConfidence", () => {
  it("確認直後は保存値のまま", () => {
    const now = at("2026-08-20T00:00:00Z");
    expect(decayedConfidence(1, "2026-08-20T00:00:00Z", now)).toBe(1);
  });

  it(`半減期（${HALF_LIFE_DAYS}日）でおよそ半分になる`, () => {
    const confirmed = at("2026-08-20T00:00:00Z");
    const now = new Date(confirmed.getTime() + HALF_LIFE_DAYS * day);
    expect(decayedConfidence(1, confirmed.toISOString(), now)).toBeCloseTo(0.5, 5);
  });

  it("2半減期でおよそ 1/4 になる", () => {
    const confirmed = at("2026-08-20T00:00:00Z");
    const now = new Date(confirmed.getTime() + 2 * HALF_LIFE_DAYS * day);
    expect(decayedConfidence(1, confirmed.toISOString(), now)).toBeCloseTo(0.25, 5);
  });

  it("保存値が 0（訂正済み）なら経過しても 0 のまま", () => {
    const now = at("2026-12-31T00:00:00Z");
    expect(decayedConfidence(0, "2026-08-20T00:00:00Z", now)).toBe(0);
  });

  it("時刻が読めない行は減らさない（訂正で 0 にした行と区別できなくなるため）", () => {
    const now = at("2026-08-20T00:00:00Z");
    expect(decayedConfidence(0.8, null, now)).toBe(0.8);
    expect(decayedConfidence(0.8, "", now)).toBe(0.8);
    expect(decayedConfidence(0.8, "not-a-date", now)).toBe(0.8);
  });

  it("未来日時（時計ずれ）で保存値を超えない", () => {
    const now = at("2026-08-20T00:00:00Z");
    expect(decayedConfidence(1, "2026-09-20T00:00:00Z", now)).toBe(1);
  });

  it("単調に減る（途中で増えない）", () => {
    const confirmed = "2026-08-20T00:00:00Z";
    const base = at(confirmed).getTime();
    let previous = Infinity;
    for (const days of [0, 1, 7, 30, 90, 365]) {
      const value = decayedConfidence(1, confirmed, new Date(base + days * day));
      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
    expect(previous).toBeGreaterThan(0);
  });
});
