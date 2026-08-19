import { describe, it, expect } from "vitest";
import { MAX_FULL_RUNS_PER_DAY, canRunFullHarness, budgetDateKey } from "@edge/_shared/budget";
import { jstDateKey } from "@edge/_shared/jst";

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

/**
 * **上限の1日は JST 基準**（2026-08-19 検収者指摘で UTC から変更）。
 *
 * 上限は運用者（日本）が「今日はもう回さない」と読む単位であり、
 * 配信の冪等キー（`pulse:<company_id>:<JST日付>`）と1日の切れ目が揃っていないと突合できない。
 * UTC 基準だとリセットが毎朝 9時 JST になり、配信の対象日と1日ずれる。
 */
describe("budgetDateKey", () => {
  it("budget_usage.date に入れる YYYY-MM-DD を JST 基準で返す", () => {
    // UTC 23:30 = JST 翌日 08:30
    expect(budgetDateKey(new Date("2026-08-19T23:30:00.000Z"))).toBe("2026-08-20");
    // UTC 14:59 = JST 同日 23:59
    expect(budgetDateKey(new Date("2026-08-19T14:59:00.000Z"))).toBe("2026-08-19");
  });

  it("同じ JST 日の別時刻で同じキーになる（1日1行に収束する）", () => {
    const a = budgetDateKey(new Date("2026-08-19T15:00:00.000Z")); // JST 8/20 00:00
    const b = budgetDateKey(new Date("2026-08-20T14:59:59.000Z")); // JST 8/20 23:59
    expect(a).toBe(b);
    expect(a).toBe("2026-08-20");
  });

  it("配信の日付キーと同じ実装に寄っている（日次の意味を2つ持たない）", () => {
    const at = new Date("2026-08-19T23:30:00.000Z");
    expect(budgetDateKey(at)).toBe(jstDateKey(at));
  });
});
