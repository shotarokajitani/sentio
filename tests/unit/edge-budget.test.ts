import { describe, it, expect } from "vitest";
import {
  MAX_FULL_RUNS_PER_DAY,
  DEFAULT_PLAN,
  TRIAL_PLAN,
  STANDARD_PLAN,
  PLANS,
  planFor,
  canRunFullHarness,
  budgetDateKey,
} from "@edge/_shared/budget";
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

/**
 * プランごとの枠（2026-09-02 追加・課金の受け皿）。
 *
 * **いちばん大事なのは「挙動が変わっていない」ことである。**
 * 受け皿を作っただけで、どの会社も既定プランを引く。
 */
describe("プランの受け皿", () => {
  it("**既定プランの上限は従来と同じ 10**（挙動を変えていない）", () => {
    expect(DEFAULT_PLAN.fullRunsPerDay).toBe(10);
    expect(MAX_FULL_RUNS_PER_DAY).toBe(DEFAULT_PLAN.fullRunsPerDay);
  });

  it("プランを渡さなければ既定プランで判定する（従来の呼び出しが壊れない）", () => {
    expect(canRunFullHarness(9)).toBe(true);
    expect(canRunFullHarness(10)).toBe(false);
    expect(canRunFullHarness(9, DEFAULT_PLAN)).toBe(canRunFullHarness(9));
  });

  it("プランごとに上限が変わる", () => {
    const wide = { id: "wide", fullRunsPerDay: 50 };
    expect(canRunFullHarness(30, wide)).toBe(true);
    expect(canRunFullHarness(30)).toBe(false); // 既定では 10 が上限
    expect(canRunFullHarness(50, wide)).toBe(false);
  });

  it("使用量が取れないときは、どのプランでも起動しない（fail-closed は据え置き）", () => {
    const wide = { id: "wide", fullRunsPerDay: 50 };
    for (const v of [null, undefined, NaN]) {
      expect(canRunFullHarness(v, wide), String(v)).toBe(false);
    }
  });

  it("**知らない plan id は既定に落とす**（上限なしにも0回にもしない）", () => {
    expect(planFor("知らないプラン")).toBe(DEFAULT_PLAN);
    expect(planFor(null)).toBe(DEFAULT_PLAN);
    expect(planFor(undefined)).toBe(DEFAULT_PLAN);
    expect(planFor("")).toBe(DEFAULT_PLAN);
  });

  it("既定プランは id で引ける", () => {
    expect(planFor(DEFAULT_PLAN.id)).toBe(DEFAULT_PLAN);
  });

  it("**PLANS を空にしない**（0件で緑になるのは受け皿が消えたということ）", () => {
    expect(Object.keys(PLANS).length).toBeGreaterThan(0);
    expect(PLANS[DEFAULT_PLAN.id]).toBe(DEFAULT_PLAN);
  });

  it("プランの上限は正の整数である（0や負を置くと全社が止まる）", () => {
    for (const [id, plan] of Object.entries(PLANS)) {
      expect(Number.isInteger(plan.fullRunsPerDay), id).toBe(true);
      expect(plan.fullRunsPerDay, id).toBeGreaterThan(0);
    }
  });
});

/**
 * 2段構成（2026-09-02 決定）。試用 0円/3回、標準 月3万円/10回。
 */
describe("プランの品揃え", () => {
  it("試用は 3 回。標準は 10 回", () => {
    expect(TRIAL_PLAN.fullRunsPerDay).toBe(3);
    expect(STANDARD_PLAN.fullRunsPerDay).toBe(10);
  });

  it("**既定は標準のまま**。既存の会社の枠を減らしていない", () => {
    // 課金が動き出したら購読の無い会社は試用に落ちるが、購読という概念がまだ無い。
    // ここを試用にすると、いまいる会社の枠を黙って 10 → 3 に減らすことになる
    expect(DEFAULT_PLAN).toBe(STANDARD_PLAN);
    expect(MAX_FULL_RUNS_PER_DAY).toBe(10);
  });

  it("両方のプランが id で引ける", () => {
    expect(planFor("trial")).toBe(TRIAL_PLAN);
    expect(planFor("standard")).toBe(STANDARD_PLAN);
  });

  it("試用の枠で 3 回目は止まる", () => {
    expect(canRunFullHarness(2, TRIAL_PLAN)).toBe(true);
    expect(canRunFullHarness(3, TRIAL_PLAN)).toBe(false);
  });

  it("段数は2つ。**増やすときは価格と枠をセットで決める**", () => {
    expect(Object.keys(PLANS).sort()).toEqual(["standard", "trial"]);
  });
});
