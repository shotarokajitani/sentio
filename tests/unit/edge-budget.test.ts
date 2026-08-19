import { describe, it, expect } from "vitest";
import { MAX_FULL_RUNS_PER_DAY, canRunFullHarness, budgetDateKey } from "@edge/_shared/budget";

/**
 * S-6-2 〜 S-6-6: 調査予算。
 *
 * 修復前は `used, daily_limit` という**実在しない列**を引き、エラーを無視して
 * `budgetData = null` → `budgetExhausted` が falsy になっていた。
 * つまり「行が無ければ無制限」であり、**上限で止まる経路が存在しなかった**（fail-open）。
 * 金銭リスクを伴うので fail-closed に反転させる。
 */

describe("MAX_FULL_RUNS_PER_DAY", () => {
  it("定数は1箇所（_shared）に置き、環境変数で変えない", () => {
    expect(MAX_FULL_RUNS_PER_DAY).toBe(10);
  });

  it("合成会社の一気通貫（S-3-2）が上限に当たらない余裕がある", () => {
    // 3 だとテスト側で上限を上書きする経路が要り、
    // 「本番コードに testMode を作らない」原則と衝突する
    expect(MAX_FULL_RUNS_PER_DAY).toBeGreaterThanOrEqual(10);
  });
});

describe("canRunFullHarness", () => {
  it("使用量が上限未満なら起動できる", () => {
    expect(canRunFullHarness(0)).toBe(true);
    expect(canRunFullHarness(MAX_FULL_RUNS_PER_DAY - 1)).toBe(true);
  });

  it("上限に達したら起動しない（fail-closed）", () => {
    expect(canRunFullHarness(MAX_FULL_RUNS_PER_DAY)).toBe(false);
  });

  it("何らかの理由で上限を超えていても起動しない", () => {
    expect(canRunFullHarness(MAX_FULL_RUNS_PER_DAY + 5)).toBe(false);
  });

  it("使用量が取れなかった場合は起動しない — 「行が無ければ無制限」を作らない", () => {
    expect(canRunFullHarness(null)).toBe(false);
    expect(canRunFullHarness(undefined)).toBe(false);
    expect(canRunFullHarness(Number.NaN)).toBe(false);
  });
});

describe("budgetDateKey", () => {
  it("budget_usage.date に入れる YYYY-MM-DD を返す", () => {
    expect(budgetDateKey(new Date("2026-08-19T23:30:00.000Z"))).toBe("2026-08-19");
  });

  it("同じ日の別時刻で同じキーになる（1日1行に収束する）", () => {
    const a = budgetDateKey(new Date("2026-08-19T00:00:00.000Z"));
    const b = budgetDateKey(new Date("2026-08-19T23:59:59.000Z"));
    expect(a).toBe(b);
  });
});
