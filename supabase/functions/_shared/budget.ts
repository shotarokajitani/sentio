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
export const MAX_FULL_RUNS_PER_DAY = 10;

/**
 * フルハーネスを起動してよいか。
 *
 * **使用量が取れなかった場合は起動しない。** `null` / `undefined` / `NaN` を
 * 「0回使用」に丸めると、それは「行が無ければ無制限」の再来になる。
 */
export function canRunFullHarness(fullRuns: number | null | undefined): boolean {
  if (typeof fullRuns !== "number" || Number.isNaN(fullRuns)) return false;
  return fullRuns < MAX_FULL_RUNS_PER_DAY;
}

/** `budget_usage.date`（DATE 型）に入れるキー。 */
export function budgetDateKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}
