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

/**
 * 連携の状態（PS-9a）。**関門を開けるのは `revoked` と `reauth_required` の2つだけ。**
 * 「active 以外すべて」にしない——`pending` は認可が完了していない行で、
 * 再連携のお願いを送る相手ではない。
 */
export type ConnectionState = "active" | "revoked" | "reauth_required" | "none";

/** 会社ごとの結末。**00032 の `dispatch_runs_outcome_check` と同じ集合**である */
export type CompanyOutcome =
  | "delivered"
  | "reconnect_notice"
  | "reconnect_suppressed"
  | "skipped_no_connection"
  | "skipped_no_email"
  | "failed_state"
  | "failed_sense"
  | "failed_deliver";

/**
 * 再連携のお願いを送る間隔（PS-9e）。**遷移が起きた日に1通、以後7日ごと。**
 * 毎日送らないのは、毎日届く通知が**その日から無視される対象になる**ためである。
 */
export const RECONNECT_NOTICE_INTERVAL_DAYS = 7;

export interface CompanyTarget {
  companyId: string;
  /**
   * 宛先の正本は `auth.users.email`（CD-D1）。
   * RLS が `company_id = auth.uid()` なので会社とアカウントは 1:1 である。
   * **宛先テーブルを別に持たない。** 正本が2つになると片方が古くなる。
   */
  email: string | null;
  /**
   * 連携の状態（会社ごとに1つに畳む）。**`active` が1つでもあれば `active`**、
   * 無ければ `revoked` / `reauth_required` の順に拾い、どれも無ければ `none`（CD-D3 の後継）。
   */
  connectionState: ConnectionState;
  /** 直近で「再連携のお願い」を送った時刻。**7日ごとの判定に使う**（PS-9e） */
  lastReconnectNoticeAt: string | null;
  /**
   * 連携が切れたことを検知した時刻（文面の差し込み・PS-S4）。
   * **無ければ送らない**——「(不明) から取り込めていません」を顧客に出さない
   */
  detectedAt: string | null;
}

/** 1社ぶんの判断。**実行はしない** */
export type CompanyPlan =
  | { action: "deliver" }
  | { action: "reconnect" }
  | { action: "suppress"; outcome: "reconnect_suppressed"; reason: string }
  | { action: "skip"; outcome: "skipped_no_connection" | "skipped_no_email" };

/**
 * その会社に何をするかを決める。**判断をここに閉じる**（画面の `cardActions` と同じ作法）。
 *
 * 順序が要件である。
 *   1. 連携の状態で関門を通す（`active` ／ daily の `revoked` `reauth_required` 以外は落とす）
 *   2. 宛先が無ければ落とす
 *   3. `active` は通常の配信
 *   4. 取り消し中は、7日以内に送っていなければ「再連携のお願い」、送っていれば抑制
 *
 * **weekly では再連携のお願いを送らない**（PS-9 は毎朝の経路である）。
 * 週次でも送ると、同じ内容が週2回届く。
 */
export function planCompany(target: CompanyTarget, kind: DispatchKind, now: Date): CompanyPlan {
  const needsReconnect =
    target.connectionState === "revoked" || target.connectionState === "reauth_required";

  if (target.connectionState !== "active" && !(needsReconnect && kind === "daily")) {
    return { action: "skip", outcome: "skipped_no_connection" };
  }
  if (!target.email) return { action: "skip", outcome: "skipped_no_email" };
  if (target.connectionState === "active") return { action: "deliver" };

  const last = target.lastReconnectNoticeAt ? new Date(target.lastReconnectNoticeAt) : null;
  if (last && !Number.isNaN(last.getTime())) {
    const days = (now.getTime() - last.getTime()) / (24 * 60 * 60 * 1000);
    if (days < RECONNECT_NOTICE_INTERVAL_DAYS) {
      // **「送らなかった」を「送り損ねた」と混ぜない。** 理由を添えて残す（PS-9f）
      return {
        action: "suppress",
        outcome: "reconnect_suppressed",
        reason: `sent_within_${RECONNECT_NOTICE_INTERVAL_DAYS}_days`,
      };
    }
  }

  return { action: "reconnect" };
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
  /**
   * 実行の記録を残す（PS-8）。**0社でも `kind='run'` の1行は必ず書く。**
   *
   * ここで throw しない。記録の失敗で配信そのものを落とすと、
   * 「送れたのに 5xx」が起きる。失敗は値で返し、summary に出す。
   */
  recordDispatch(rows: DispatchRecord[]): Promise<{ ok: boolean; error?: string }>;
}

/** `dispatch_runs`（00032）に書く1行。**列と同じ形にしてある** */
export type DispatchRecord =
  | { kind: "run"; dispatch: DispatchKind; companies: number }
  | {
      kind: "company";
      dispatch: DispatchKind;
      companyId: string;
      outcome: CompanyOutcome;
      reason?: string;
    };

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
  /** 再連携のお願いを送った会社数（PS-9） */
  reconnect_notice: number;
  /** **送らなかった**会社数（7日以内に送っている。PS-9e/f） */
  reconnect_suppressed: number;
  /**
   * 実行の記録を書けたか（PS-8）。**書けなかったことを黙らせない。**
   * `failed` は配信の失敗数なので、ここは別に持つ
   */
  recorded: boolean;
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
    reconnect_notice: 0,
    reconnect_suppressed: 0,
    recorded: false,
  };

  const records: DispatchRecord[] = [];
  const now = new Date();

  for (const target of targets) {
    const plan = planCompany(target, kind, now);

    // 連携ゼロの会社に空のパルスを送らない（CD-1-2）／宛先が無ければ呼ばない（CD-1-3）。
    // **落とした事実は記録に残す**（PS-8）
    if (plan.action === "skip") {
      if (plan.outcome === "skipped_no_connection") summary.skipped_no_connection++;
      else summary.skipped_no_email++;
      records.push({
        kind: "company",
        dispatch: kind,
        companyId: target.companyId,
        outcome: plan.outcome,
      });
      continue;
    }

    // **送らなかった日も残す**（PS-9f）。「送り損ねた」（failed_deliver）と別の値にしてある
    if (plan.action === "suppress") {
      summary.reconnect_suppressed++;
      records.push({
        kind: "company",
        dispatch: kind,
        companyId: target.companyId,
        outcome: plan.outcome,
        reason: plan.reason,
      });
      continue;
    }

    // 取り消し中の会社には**再連携のお願いだけ**を送る（PS-9b）。
    //
    // **`state-baselines` も `run-sense` も呼ばない。** 取り込みが止まっている会社に
    // 平常の状態記述を出すと、**古い値を今の状態として提示する**ことになる。
    // 同時に、この経路は LLM へ入らない（LLM は `run-sense` → `investigate` の先にある）。
    // **呼ばないことが担保である**（PS-9c）
    if (plan.action === "reconnect") {
      const notice = await deps.invoke("deliver-pulse", {
        company_id: target.companyId,
        email: target.email,
        kind: "reconnect",
        // 差し込みは2つだけ（PS-S4・会社名は 2026-09-08 に文面から外した）。
        // **欠けたら deliver 側が送らずに 500 を返す**
        detected_at: target.detectedAt,
      });

      if (notice.ok) {
        summary.reconnect_notice++;
        records.push({
          kind: "company",
          dispatch: kind,
          companyId: target.companyId,
          outcome: "reconnect_notice",
        });
      } else {
        summary.failed++;
        records.push({
          kind: "company",
          dispatch: kind,
          companyId: target.companyId,
          outcome: "failed_deliver",
          reason: `status_${notice.status}`,
        });
      }
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
        records.push({
          kind: "company",
          dispatch: kind,
          companyId: target.companyId,
          outcome: "failed_state",
          reason: `status_${state.status}`,
        });
      }

      const sense = await deps.invoke("run-sense", { company_id: target.companyId });
      if (!sense.ok) {
        // **sense の失敗で配信を止めない**（CD-2-4）。ただし失敗として数える
        summary.sense_failed++;
        summary.failed++;
        records.push({
          kind: "company",
          dispatch: kind,
          companyId: target.companyId,
          outcome: "failed_sense",
          reason: `status_${sense.status}`,
        });
      }
    }

    const deliverFn = kind === "daily" ? "deliver-pulse" : "deliver-weekly";
    const delivered = await deps.invoke(deliverFn, {
      company_id: target.companyId,
      email: target.email,
    });

    if (delivered.ok) {
      summary.delivered++;
      records.push({
        kind: "company",
        dispatch: kind,
        companyId: target.companyId,
        outcome: "delivered",
      });
    } else {
      summary.failed++;
      records.push({
        kind: "company",
        dispatch: kind,
        companyId: target.companyId,
        outcome: "failed_deliver",
        reason: `status_${delivered.status}`,
      });
    }
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

  // **異常の有無に関わらず、毎日1行の実行記録が残る**（改訂後の PS-5）。
  // 0社の日も `companies: 0` の行が残るので、
  // **「0社だった」と「cron が発火していない」が区別できる。**
  records.push({ kind: "run", dispatch: kind, companies: targets.length });

  const recorded = await deps.recordDispatch(records);
  summary.recorded = recorded.ok;
  if (!recorded.ok) {
    // **記録の失敗を黙らせない。** ただし配信の失敗数（failed）には混ぜない
    console.error("dispatch: 実行記録の書き込みに失敗:", recorded.error ?? "unknown");
  }

  // 失敗があれば non-2xx。**呼び出し元（cron）は読まないが、手動実行と CI からは読める**
  //
  // 課金の未解決は `failed` に足さない（あちらは配信・Sense・State の失敗数である）。
  // **数え方を混ぜずに、non-2xx にだけ効かせる。**
  // 記録できなかった実行も non-2xx にする。**記録が無いと、後から何も辿れない**
  const failed = summary.failed > 0 || billingProblem || !summary.recorded;
  return { status: failed ? 502 : 200, body: { ...summary } };
}
