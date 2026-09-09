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
 * 試用プラン。**0円。**
 *
 * **枠は 5。3 から上げた（2026-09-02 実測にもとづく変更）。**
 *
 * `investigate` は候補を `scanType` でまとめて1調査にする（`planInvestigations`）。
 * 走査は5種類（乖離 / 傾向 / 途絶 / 期日 / 外部着火）しか無いので、
 * **どれだけ候補が出てもフルハーネスの起動は1日5回が上限**である
 * （合成会社での実測: 候補13件 → 5群）。
 *
 * 3 のままだと**試用の会社は毎日2件を取りこぼす。** 3 という数字は
 * 「S-3-2 のテストが上限に当たる」という理由だけで置いたもので、
 * **利用者の体験から決めた値ではなかった。**
 * 試用は製品の第一印象そのものなので、**全部見える 5 にする。**
 */
export const TRIAL_PLAN: Plan = { id: "trial", fullRunsPerDay: 5 };

/**
 * 標準プラン（2026-09-02 梶谷さん決定）。
 * **金額の正本は Next 側の `src/lib/pricing.ts` である**（2026-09-09 に定数化）。
 * ここに数字を書くと、値上げのときに直し漏れる面がひとつ増える。
 *
 * 年36万円で、正本 `06_positioning.md` が持つ最小の代替コスト
 * （5名×毎日15分の日報＝年90万円）の4割にあたる。
 * 枠は従来の `MAX_FULL_RUNS_PER_DAY` と同じ 10 で、暫定値であることも変わらない
 * （`docs/spec/07_open_items.md` に登録済み）。
 */
export const STANDARD_PLAN: Plan = { id: "standard", fullRunsPerDay: 10 };

/**
 * plan id が引けないときに落とす先。**試用プランである**（2026-09-09 に倒した）。
 *
 * 倒した理由は2つ。
 *
 * 1. **未購読のアカウントに標準枠で LLM 費用が出る。** Stripe が本番で回り始め、
 *    購読の有無が引けるようになったので、既定を購読なし側に置く
 * 2. **体験は変わらない。** `investigate` は候補を `scanType` でまとめるので、
 *    走査が5種の現状では起動は1日最大5回である。5 でも取りこぼさない
 *    （`tests/unit/edge-budget.test.ts` が走査の種類数と枠を突き合わせて固定している）
 *
 * **走査が6種以上に増えたら、この前提は崩れる。** そのとき試験が赤くなる。
 */
export const DEFAULT_PLAN: Plan = TRIAL_PLAN;

/** 引ける全プラン。**空にしない。**（2段構成・2026-09-02 決定） */
export const PLANS: Readonly<Record<string, Plan>> = {
  [TRIAL_PLAN.id]: TRIAL_PLAN,
  [STANDARD_PLAN.id]: STANDARD_PLAN,
};

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
 * フルハーネス（Planner→Generator→Evaluator）の日次起動上限（**既定プランの値**）。
 *
 * **会社ごとの上限はこれではない。** 2026-09-09 から `investigate` は
 * 会社の購読からプランを解決し、`plan.fullRunsPerDay` を使う。
 * ここは「プランが引けなかったときに落ちる先」の値であり、
 * **ログや応答に出すのは解決済みのプランの値である**（発注 B-1 の条件2）。
 *
 * `light_runs` に上限は置かない。`spec/03:52` が「フルハーネス起動上限・超過はライトパス降格」
 * と定めており、**ライトを絞ると降格先が無くなる**ため。記録だけ行う。
 */
export const MAX_FULL_RUNS_PER_DAY = DEFAULT_PLAN.fullRunsPerDay;

/**
 * `investigate` が候補をまとめる単位（`scanType`）の種類数。
 *
 * **枠がこの数を下回ると、走査が出した候補を取りこぼす。**
 * `_shared/scan.ts` が出す `scanType` は
 * `deviation` / `deadline` / `external` / `trend` / `silence` の5種。
 * ここを実装から機械的に導けないのは、`scan.ts` が候補を返すまで種類が分からないためで、
 * **突合は `tests/unit/edge-budget.test.ts` が実物の `runScan` の出力で行う。**
 */
export const SCAN_TYPE_COUNT = 5;

/**
 * 枠を与えてよい購読状態。**この集合が「購読している」の定義である**（発注 B-4）。
 *
 * `subscription-state.ts` の「購読の実体があるか」（否定リスト）とは**別物**である。
 * あちらは「2本目を作らせない」ための門で、こちらは「枠と配信を与えるか」の判定。
 * **片方をもう片方で代用しない。**
 */
export const ENTITLED_STATUSES: ReadonlySet<string> = new Set(["active", "trialing"]);

export function isEntitledStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && ENTITLED_STATUSES.has(status);
}

/**
 * `auth.users.user_metadata` からプランを解決する（**Next と Edge の共通実体**）。
 *
 * Edge は `supabase/functions/` の外を import できないので、実体をここに置き、
 * Next 側（`src/lib/billing/plan.ts`）はこれを呼ぶ。**二重に実装しない。**
 *
 * 落とす先は `TRIAL_PLAN` であって 0 ではない。0 にすると請求の不整合で利用者が完全に止まる。
 */
export function planFromSubscriptionMetadata(metadata: unknown): Plan {
  const sub = (metadata as { subscription?: { plan_id?: unknown; status?: unknown } } | null)
    ?.subscription;
  if (!sub || typeof sub !== "object") return TRIAL_PLAN;
  if (!isEntitledStatus(typeof sub.status === "string" ? sub.status : null)) return TRIAL_PLAN;
  return planFor(typeof sub.plan_id === "string" ? sub.plan_id : null);
}

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
