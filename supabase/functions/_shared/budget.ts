/**
 * 調査予算（契約 S-6-2 〜 S-6-6）。
 *
 * 修復前の `investigate/index.ts` は `used, daily_limit` という**実在しない列**を引き、
 * エラーを無視して `budgetData = null` にしていた。`budgetExhausted` は常に falsy になり、
 * **上限で止まる経路そのものが存在しなかった**。「行が無ければ無制限」という fail-open で、
 * 金銭リスクを伴う。ここを fail-closed に反転させる。
 *
 * **定数はここ1箇所だけに置く。環境変数化しない**（S-6-5）。
 * 値をプラン階層と結び付けるのはスライス5。
 */

import { jstDateKey } from "./jst.ts";

/**
 * プランごとの枠（entitlement）。**課金の受け皿**。
 *
 * ロードマップ第5フェーズ「事業化仕上げ」は
 * 「プラン entitlement（**調査予算×枠**）」と定めている。その受け皿だけを先に作る。
 *
 * **いまは会社ごとの差が無い。** どの会社も `DEFAULT_PLAN` を引くので、
 * **この変更で本番の挙動は1ミリも変わらない**（`MAX_FULL_RUNS_PER_DAY` は
 * 既定プランの値そのものであり、値は 10 のまま）。
 *
 * **プランの種類・価格・枠は未確定である**（人間の判断待ち）。
 * ここに `free` や `pro` のような名前を先に置かないのは、
 * **名前を置いた時点で品揃えを決めたことになる**からである。
 * 決まったら `PLANS` に足し、会社ごとの plan id を引く経路（下記）を繋ぐ。
 */
export interface Plan {
  /** プランの識別子。契約・請求と突き合わせる鍵になる */
  id: string;
  /** フルハーネスの日次起動上限 */
  fullRunsPerDay: number;
}

/**
 * 既定のプラン。**いまは全社がこれである。**
 *
 * 値は従来の `MAX_FULL_RUNS_PER_DAY` と同じ 10 で、暫定値であることも変わらない
 * （`docs/spec/07_open_items.md` に登録済み）。
 */
export const DEFAULT_PLAN: Plan = { id: "default", fullRunsPerDay: 10 };

/** 引ける全プラン。**空にしない。** 課金が決まったらここに足す */
export const PLANS: Readonly<Record<string, Plan>> = { [DEFAULT_PLAN.id]: DEFAULT_PLAN };

/**
 * plan id からプランを引く。**知らない id は既定プランに落とす。**
 *
 * 「知らない id ＝ 上限なし」にも「知らない id ＝ 0回」にもしない。
 * 前者は fail-open で金銭リスクを伴い（この module がまさにそれを直した経緯を持つ）、
 * 後者は請求の不整合で利用者を止めてしまう。
 * **既定に落とすのは、どちらの事故も起こさない唯一の選択である。**
 */
export function planFor(planId: string | null | undefined): Plan {
  if (typeof planId !== "string") return DEFAULT_PLAN;
  return PLANS[planId] ?? DEFAULT_PLAN;
}

/**
 * フルハーネス（Planner→Generator→Evaluator）の日次起動上限。
 *
 * **10 は暫定値**（`docs/spec/07_open_items.md` に登録済み）。
 * 3 にすると S-3-2（合成会社の一気通貫）が上限に当たり、テスト側で上限を上書きする
 * 経路が必要になる。それは「本番コードに `if (testMode)` を作らない」原則と衝突するため、
 * テストが素通しできる余裕を持たせてある。
 *
 * `light_runs` に上限は置かない。`spec/03:52` が「フルハーネス起動上限・超過はライトパス降格」
 * と定めており、**ライトを絞ると降格先が無くなる**ため。記録だけ行う。
 */
export const MAX_FULL_RUNS_PER_DAY = DEFAULT_PLAN.fullRunsPerDay;

/**
 * フルハーネスを起動してよいか。
 *
 * **使用量が取れなかった場合は起動しない。** `null` / `undefined` / `NaN` を
 * 「0回使用」に丸めると、それは「行が無ければ無制限」の再来になる。
 *
 * `plan` を省略すると既定プラン。**いまはどの会社も既定プランなので挙動は変わらない。**
 */
export function canRunFullHarness(
  fullRuns: number | null | undefined,
  plan: Plan = DEFAULT_PLAN,
): boolean {
  if (typeof fullRuns !== "number" || Number.isNaN(fullRuns)) return false;
  return fullRuns < plan.fullRunsPerDay;
}

/**
 * `budget_usage.date`（DATE 型）に入れるキー。
 *
 * **JST 基準**（`_shared/jst.ts`）。2026-08-19 まで `toISOString().slice(0, 10)` の
 * UTC 基準で、上限のリセットが毎朝 9時 JST になっていた。
 * 上限は運用者（日本）が「今日はもう回さない」と読む単位であり、
 * 配信の冪等キー（`pulse:<company_id>:<JST日付>`）と1日の切れ目が揃っていないと突合できない。
 */
export function budgetDateKey(now: Date): string {
  return jstDateKey(now);
}
