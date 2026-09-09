import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  MAX_FULL_RUNS_PER_DAY,
  SCAN_TYPE_COUNT,
  planFromSubscriptionMetadata,
  isEntitledStatus,
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
    // **既定は試用プランである**（2026-09-09 に倒した）。
    // 未購読のアカウントに標準枠で LLM 費用が出る形をやめた
    expect(MAX_FULL_RUNS_PER_DAY).toBe(TRIAL_PLAN.fullRunsPerDay);
  });

  it("合成会社の一気通貫（S-3-2）が上限に当たらない余裕がある", () => {
    // 3 だとテスト側で上限を上書きする経路が要り、
    // 「本番コードに testMode を作らない」原則と衝突する
    expect(MAX_FULL_RUNS_PER_DAY).toBeGreaterThanOrEqual(5);
  });
});

/**
 * **枠が走査の種類数を下回ったら、候補を取りこぼす**（発注 B-1 の条件1）。
 *
 * `investigate` は候補を `scanType` でまとめてから1群1回起動する。
 * したがって1日の起動回数の上限は「`scanType` の種類数」で決まる。
 * 走査が6種以上に増えたら、試用プランの 5 では足りなくなる——**そのときここが赤くなる。**
 *
 * 種類数は `_shared/scan.ts` の実物から数える。**人が書いた表を持たない。**
 */
describe("試用プランの枠と走査の種類数（B-1 条件1）", () => {
  const scanSource = readFileSync(
    path.resolve(__dirname, "../../supabase/functions/_shared/scan.ts"),
    "utf8",
  );

  const scanTypes = new Set([...scanSource.matchAll(/scanType:\s*"([a-z_]+)"/g)].map((m) => m[1]));

  it("走査の種類が数えられている（0件で緑にならない）", () => {
    expect(scanTypes.size).toBeGreaterThan(0);
    expect(scanTypes.size).toBe(SCAN_TYPE_COUNT);
  });

  it("**試用プランの枠で、走査5種すべてが起動できる**（取りこぼし0件）", () => {
    expect(TRIAL_PLAN.fullRunsPerDay).toBeGreaterThanOrEqual(scanTypes.size);
  });

  it("既定プランでも同じ（既定は試用である）", () => {
    expect(DEFAULT_PLAN.fullRunsPerDay).toBeGreaterThanOrEqual(scanTypes.size);
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
  it("**既定プランは試用**（2026-09-09 に倒した）", () => {
    expect(DEFAULT_PLAN).toBe(TRIAL_PLAN);
    expect(MAX_FULL_RUNS_PER_DAY).toBe(DEFAULT_PLAN.fullRunsPerDay);
  });

  it("プランを渡さなければ既定プランで判定する（従来の呼び出しが壊れない）", () => {
    expect(canRunFullHarness(TRIAL_PLAN.fullRunsPerDay - 1)).toBe(true);
    expect(canRunFullHarness(TRIAL_PLAN.fullRunsPerDay)).toBe(false);
    expect(canRunFullHarness(1, DEFAULT_PLAN)).toBe(canRunFullHarness(1));
  });

  it("プランごとに上限が変わる", () => {
    const wide = { id: "wide", fullRunsPerDay: 50 };
    expect(canRunFullHarness(30, wide)).toBe(true);
    expect(canRunFullHarness(30)).toBe(false); // 既定（試用）では 5 が上限
    expect(canRunFullHarness(50, wide)).toBe(false);
    // 標準プランは試用より広い（**課金の意味がここにある**）
    expect(STANDARD_PLAN.fullRunsPerDay).toBeGreaterThan(TRIAL_PLAN.fullRunsPerDay);
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
  it("試用は 5 回。標準は 10 回", () => {
    expect(TRIAL_PLAN.fullRunsPerDay).toBe(5);
    expect(STANDARD_PLAN.fullRunsPerDay).toBe(10);
  });

  /**
   * **フルハーネスの起動は1日5回が上限である**（2026-09-02 実測）。
   * `investigate` は候補を `scanType` でまとめて1調査にし、走査は5種類しか無い。
   * 試用がこれを下回ると、**毎日取りこぼしが出る。**
   */
  it("試用の枠は、1日に起こりうる調査の数（5）を下回らない", () => {
    const SCAN_TYPES_PER_DAY = 5;
    expect(TRIAL_PLAN.fullRunsPerDay).toBeGreaterThanOrEqual(SCAN_TYPES_PER_DAY);
  });

  it("**既定は試用**。購読が無い会社に標準枠を与えない（2026-09-09 に倒した）", () => {
    // 倒す前は標準だった。**課金が本番で回り始め、購読の有無が引けるようになった**ので、
    // 既定を購読なし側に置く。体験は変わらない（走査は5種で、起動は1日最大5回）
    expect(DEFAULT_PLAN).toBe(TRIAL_PLAN);
    expect(MAX_FULL_RUNS_PER_DAY).toBe(TRIAL_PLAN.fullRunsPerDay);
    // **購読していれば標準に上がる**（ここが課金の意味である）
    expect(
      planFromSubscriptionMetadata({
        subscription: { plan_id: "standard", status: "active" },
      }),
    ).toBe(STANDARD_PLAN);
  });

  it("両方のプランが id で引ける", () => {
    expect(planFor("trial")).toBe(TRIAL_PLAN);
    expect(planFor("standard")).toBe(STANDARD_PLAN);
  });

  it("試用の枠で 5 回目は止まる", () => {
    expect(canRunFullHarness(4, TRIAL_PLAN)).toBe(true);
    expect(canRunFullHarness(5, TRIAL_PLAN)).toBe(false);
  });

  it("段数は2つ。**増やすときは価格と枠をセットで決める**", () => {
    expect(Object.keys(PLANS).sort()).toEqual(["standard", "trial"]);
  });
});

/**
 * 購読からプランを解決する（**Next と Edge の共通実体**・発注 B-2 / B-3）。
 *
 * 実体をここ（`_shared/budget.ts`）に置いてあるのは、`investigate`（Edge）と
 * `src/lib/billing/plan.ts`（Next）の両方が要るからである。**二重に実装しない。**
 */
describe("購読からプランを解決する", () => {
  const sub = (status: string, planId = "standard") => ({
    subscription: { plan_id: planId, status, stripe_customer_id: "c", stripe_subscription_id: "s" },
  });

  it("active は標準プラン", () => {
    expect(planFromSubscriptionMetadata(sub("active"))).toBe(STANDARD_PLAN);
  });

  it("**trialing も標準プラン**（無料期間中は製品が全部使える）", () => {
    expect(planFromSubscriptionMetadata(sub("trialing"))).toBe(STANDARD_PLAN);
  });

  it("**陰性**: 支払いが滞っている購読は試用に落とす（0 にはしない）", () => {
    for (const status of ["past_due", "canceled", "unpaid", "paused", "incomplete"]) {
      expect(planFromSubscriptionMetadata(sub(status)), status).toBe(TRIAL_PLAN);
    }
  });

  it("**陰性**: 購読が無い会社は試用に落ちる（標準ではない）", () => {
    expect(planFromSubscriptionMetadata(null)).toBe(TRIAL_PLAN);
    expect(planFromSubscriptionMetadata({})).toBe(TRIAL_PLAN);
    expect(planFromSubscriptionMetadata({ subscription: null })).toBe(TRIAL_PLAN);
  });

  it("枠と配信を与えてよい状態は active と trialing の2つだけ", () => {
    expect(isEntitledStatus("active")).toBe(true);
    expect(isEntitledStatus("trialing")).toBe(true);
    for (const status of ["past_due", "canceled", "unpaid", "paused", "incomplete", null, ""]) {
      expect(isEntitledStatus(status), String(status)).toBe(false);
    }
  });
});
