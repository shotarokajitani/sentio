/**
 * 配信ディスパッチャの中核（契約 `docs/contracts/slice-cron-dispatch.md`・スライスCD）。
 *
 * **cron は `deliver-*` を直接叩けない。** `deliver-pulse` / `deliver-weekly` は
 * `email` が必須で（無ければ 400）、cron の本文は `'{}'::jsonb` だけである。
 * そのまま張れば毎日 400 が積み上がるだけで、誰も気づかない。
 * **あいだにこれを置き、`deliver-*` の引数要件を cron に漏らさない。**
 *
 * **依存を注入する。** `index.ts` は Deno と Supabase を繋ぐだけにして、
 * 判断（誰に送るか・失敗をどう数えるか）はこの純ロジックに閉じる。
 * `_shared/delivery.ts` の `deliverOnce(db, ...)` と同じ作法で、
 * 陰性コントロールを vitest から当てられる形にしてある。
 */

import type { CallerKind } from "./caller.ts";

export type DispatchKind = "daily" | "weekly";

export interface CompanyTarget {
  companyId: string;
  /**
   * 宛先の正本は `auth.users.email`（CD-D1）。
   * RLS が `company_id = auth.uid()` なので会社とアカウントは 1:1 である。
   * **宛先テーブルを別に持たない。** 正本が2つになると片方が古くなる。
   */
  email: string | null;
  /** `connections` に有効な行が1つ以上あるか（CD-D3） */
  hasConnection: boolean;
}

export interface InvokeResult {
  ok: boolean;
  status: number;
}

/**
 * 課金 webhook の取りこぼしの件数（④-a）。
 *
 * **3つとも出す。項目ごと消さない。**
 * `resolved` を出すのは「解決した」と「そもそも何も起きていない」を分けるため。
 * `stale` を出すのは「**再送中でまだ望みがある**」と「**再送が尽きた**」を分けるため
 * ——Stripe の再送は本番で最大3日・指数バックオフで、そこを過ぎたら人が動くしかない。
 */
export interface BillingCounts {
  /** `resolved_at IS NULL`。**メールと non-2xx の判断はこれだけで行う** */
  unresolved: number;
  /** `resolved_at IS NOT NULL`（累計）。再送で直った分もここに入る */
  resolved: number;
  /** 未解決のうち、受信から3日を超えたもの。**Stripe の再送が尽きた見込み** */
  stale: number;
}

/** Stripe の webhook 再送の上限（本番で最大3日・指数バックオフ）。 */
export const STRIPE_RETRY_WINDOW_DAYS = 3;

/** 運用宛の通知の結果。**送ったつもりを作らない**ので、失敗も値で返す */
export interface OpsNotifyResult {
  ok: boolean;
  /** `not_configured` は宛先（SENTIO_OPS_EMAIL）や Resend の設定が無い場合 */
  reason?: "not_configured" | "send_failed";
  error?: string;
}

export interface DispatchDeps {
  listTargets(): Promise<CompanyTarget[]>;
  invoke(fn: string, body: Record<string, unknown>): Promise<InvokeResult>;
  /**
   * 会社を引けなかった課金 webhook の件数（④-a）。
   *
   * **集計に失敗したら null を返す。** 0件と区別できなくなると
   * 「0件が続いている」と「集計の経路が壊れている」が同じ顔になる。
   */
  countBillingUnresolved(): Promise<BillingCounts | null>;
  /** 1件以上あるときだけ呼ぶ。運用宛に1通出す */
  notifyOpsBillingUnresolved(count: number): Promise<OpsNotifyResult>;
}

/**
 * 集計。**メールアドレスを載せない**（CD-2-3）。会社数と件数だけを出す。
 * これは cron のログにも Actions のログにも流れうるので、宛先を書くと系の外に出る。
 */
export interface DispatchSummary {
  kind: DispatchKind;
  companies: number;
  delivered: number;
  skipped_no_connection: number;
  skipped_no_email: number;
  /** `state-baselines` と `run-sense` と `deliver-*` を合わせた失敗件数 */
  failed: number;
  /** うち `run-sense` の失敗（配信は止めない。CD-2-4） */
  sense_failed: number;
  /** うち `state-baselines` の失敗（配信も Sense も止めない。SB-D2） */
  state_failed: number;
  /**
   * 会社を引けなかった課金 webhook の未対処件数（daily のみ・④-a）。
   *
   * **0件でも必ず出す。項目ごと消さない。** 出さないと
   * 「0件が続いている」と「集計の経路が壊れている」が区別できなくなる（PS-2 と同じ形）。
   * `null` は**集計そのものに失敗した**ことを表す。
   */
  billing_unresolved?: number | null;
  /**
   * 解決済みの累計（daily のみ）。**集計からは外すが、件数は消さない**（④-a・2-4）。
   * 再送で直った行もここに入る。`null` は集計そのものの失敗。
   */
  billing_resolved?: number | null;
  /**
   * 未解決のうち受信から3日を超えたもの（daily のみ）。**Stripe の再送が尽きた見込み**。
   * **出すだけである。** これで non-2xx にするかは、実際に1件目が出てから決める（未判断）。
   */
  billing_stale?: number | null;
  /**
   * 運用宛の通知をどうしたか（daily のみ）。
   *
   * `not_needed` は0件で送る必要が無かった場合。**送信の失敗を黙らせない**ため、
   * `failed` / `not_configured` / `count_failed` はそのまま non-2xx に効かせる。
   */
  billing_alert?: "not_needed" | "sent" | "failed" | "not_configured" | "count_failed";
}

export interface DispatchResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * 全社に対して配信を回す（CD-D2）。
 *
 * **`internal` 以外の呼び出し元を受け付けない**（CD-3-2）。
 * ユーザー経路から全社配信を起動できると、1人のログインで他社への送信が走る。
 * 対象の列挙にも到達させない。
 *
 * **1社の失敗で他社を止めない**（CD-2-1）。ただし
 * **1件でも失敗があれば non-2xx を返す**（CD-2-2）。成功数だけ数えて 200 を返すと、
 * 毎朝静かに半分だけ届く状態が緑のまま続く。
 */
export async function runDispatch(
  kind: DispatchKind,
  caller: { kind: CallerKind },
  deps: DispatchDeps,
): Promise<DispatchResult> {
  if (caller.kind !== "internal") {
    return { status: 403, body: { error: "forbidden" } };
  }

  const targets = await deps.listTargets();
  const summary: DispatchSummary = {
    kind,
    companies: targets.length,
    delivered: 0,
    skipped_no_connection: 0,
    skipped_no_email: 0,
    failed: 0,
    sense_failed: 0,
    state_failed: 0,
  };

  for (const target of targets) {
    // 連携ゼロの会社に空のパルスを送らない（CD-1-2）
    if (!target.hasConnection) {
      summary.skipped_no_connection++;
      continue;
    }

    // 宛先が取れない会社は呼ばない。400 を積み上げない（CD-1-3）
    if (!target.email) {
      summary.skipped_no_email++;
      continue;
    }

    if (kind === "daily") {
      // **State を Sense より先に回す**（SB-D1）。
      //
      // `scan` の走査は `is_established` なベースラインを前提にするので、
      // 更新が後に来ると、その日の判断は**前日の平常**で行われる。
      // 別 cron に分けると順序が運任せになるため、ここに置いて構造的に固定する。
      //
      // **ここが `state-baselines` の唯一の呼び出し元である。** 2026-09-03 の実測では、
      // 本番の `baselines` は `revenue` の1行（最終更新 08-27）だけで、
      // 08-31 に足された `schedule_interval` の upsert は一度も走っていなかった。
      const state = await deps.invoke("state-baselines", { company_id: target.companyId });
      if (!state.ok) {
        // **State の失敗で Sense も配信も止めない**（SB-D2）。
        // 止めると、ベースラインが崩れた日に毎朝のパルスごと消える。
        // ただし黙って進めない。失敗として数え、non-2xx に効かせる
        summary.state_failed++;
        summary.failed++;
      }

      const sense = await deps.invoke("run-sense", { company_id: target.companyId });
      if (!sense.ok) {
        // **sense の失敗で配信を止めない**（CD-2-4）。ただし失敗として数える
        summary.sense_failed++;
        summary.failed++;
      }
    }

    const deliverFn = kind === "daily" ? "deliver-pulse" : "deliver-weekly";
    const delivered = await deps.invoke(deliverFn, {
      company_id: target.companyId,
      email: target.email,
    });

    if (delivered.ok) summary.delivered++;
    else summary.failed++;
  }

  // ④-a: 会社を引けなかった課金 webhook に**気づく経路**はここ1本だけである。
  // webhook 側は Stripe に 200 を返して行を残すことしかできない（4xx にすると再送が滞留する）。
  // 溜めるだけにすると、Sentry が鳴らないのと同じ状態を新しく作ることになる。
  //
  // **daily だけで見る。** weekly でも見ると同じ通知が週2回出て、早く読まれなくなる。
  let billingProblem = false;
  if (kind === "daily") {
    const counts = await deps.countBillingUnresolved();
    summary.billing_unresolved = counts === null ? null : counts.unresolved;
    summary.billing_resolved = counts === null ? null : counts.resolved;
    summary.billing_stale = counts === null ? null : counts.stale;

    const count = counts === null ? null : counts.unresolved;

    if (count === null) {
      // 集計が壊れているのを「0件」と読ませない
      summary.billing_alert = "count_failed";
      billingProblem = true;
    } else if (count === 0) {
      summary.billing_alert = "not_needed";
    } else {
      billingProblem = true;
      const notified = await deps.notifyOpsBillingUnresolved(count);
      summary.billing_alert = notified.ok
        ? "sent"
        : notified.reason === "not_configured"
          ? "not_configured"
          : "failed";
    }
  }

  // 失敗があれば non-2xx。**呼び出し元（cron）は読まないが、手動実行と CI からは読める**
  //
  // 課金の未解決は `failed` に足さない（あちらは配信・Sense・State の失敗数である）。
  // **数え方を混ぜずに、non-2xx にだけ効かせる。**
  const failed = summary.failed > 0 || billingProblem;
  return { status: failed ? 502 : 200, body: { ...summary } };
}
