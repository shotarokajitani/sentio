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
import { isEntitledStatus } from "./budget.ts";
import { runKeyOf, shouldStopForDeadline } from "./dispatch-resume.ts";
import { liveSources, stoppedSources, type SourceState } from "./source-state.ts";

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
  /** 購読が無いので送らなかった（B-4）。**`00035` の CHECK と同じ集合** */
  | "skipped_not_entitled"
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
  /**
   * 購読の状態（`user_metadata.subscription.status`）。**引けなければ null。**
   *
   * 判定に使うのは `isEntitledStatus`（`active` / `trialing`）で、
   * 実際に配信を止めるかどうかは `enforceEntitlement` が決める（発注 B-4）。
   */
  subscriptionStatus: string | null;
  /**
   * データ源ごとの状態（PS-9c の改訂・2026-09-13）。**無ければ従来の判定。**
   *
   * これまで対象は会社単位で決めており、Google が切れると CSV 由来の処理まで止まっていた。
   * 渡されたときは**源ごとに**判定する。
   */
  sources?: SourceState[];
}

/** 1社ぶんの判断。**実行はしない** */
export type CompanyPlan =
  | {
      action: "deliver";
      /**
       * 生きている源と止まっている源（PS-9c の改訂）。
       * **源の情報が無い会社（`sources` 未指定）では付かない**——従来の判定のまま
       */
      live?: string[];
      stopped?: SourceState[];
    }
  | { action: "reconnect" }
  | { action: "suppress"; outcome: "reconnect_suppressed"; reason: string }
  | {
      action: "skip";
      outcome: "skipped_no_connection" | "skipped_no_email" | "skipped_not_entitled";
    };

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
export function planCompany(
  target: CompanyTarget,
  kind: DispatchKind,
  now: Date,
  /**
   * 購読で配信を止めるか（発注 B-4）。**既定は false。**
   *
   * 既定を false にしてあるのは、**止める判断を入れる前に、止めた記録が
   * 正しく残ることを確かめたい**からである。環境変数
   * `SENTIO_ENFORCE_ENTITLEMENT` が `true` のときだけ止まる。
   */
  enforceEntitlement = false,
): CompanyPlan {
  // **購読が無い会社に配らない**（フラグが立っているときだけ）。
  // 連携が無いのとは別の値にする。打つ手が違う（前者は連携の導線、後者はお申し込み）
  if (enforceEntitlement && !isEntitledStatus(target.subscriptionStatus)) {
    return { action: "skip", outcome: "skipped_not_entitled" };
  }

  // ── 源ごとの判定（PS-9c の改訂）──
  //
  // **生きている源が1つでもあれば配る。** 止まっている源に依存する項目は
  // 本文から外し、代わりに「○月○日から取れていません」を1行出す（受け手の側で行う）。
  // **再連携のお願いを別のメールで送らない**——毎朝のメールの中の1行にする。
  // 2通届くと、どちらを読めばいいかが分からなくなる
  if (target.sources !== undefined) {
    const live = liveSources(target.sources);
    if (live.length > 0) {
      if (!target.email) return { action: "skip", outcome: "skipped_no_email" };
      return { action: "deliver", live, stopped: stoppedSources(target.sources) };
    }
    // **生きている源が0なら従来どおり**（再連携のお願いだけ／源が無ければ skipped）
  }

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
  /** 会社の一覧を取り切れなかったか（B-5）。取り切れていれば false */
  targetsTruncated?: boolean;
  /** 購読で配信を止めるか（B-4）。**既定は false**（環境変数の裏） */
  enforceEntitlement?: boolean;
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
  /**
   * `sending` のまま固まった行を掃除する（発注 B-1 / B-3）。**配る前に走らせる。**
   *
   * 倒した行は `RETRYABLE` に入るので、**同じ実行で再送の対象になる。**
   * 掃除を配信のあとに置くと、直った行が次の日まで待たされる。
   *
   * **ここで throw しない。** 掃除に失敗しても配信は続ける——
   * 掃除は「取りこぼしを拾う」機能であって、配信の前提ではない。
   */
  sweepStaleSending?(now: Date): Promise<{ swept: number; abandoned: number; error?: string }>;

  /**
   * 会社ごとの行を **`pending` で先に書く**（発注 ⑥J-4）。
   *
   * **これが無いと、時間切れで落ちたときに「誰が未処理か」が残らない。**
   * 記録は全部終わったあとに書いていたので、途中で落ちれば1行も残らなかった。
   *
   * 冪等。同じ `(dispatch, run_key, company_id)` は2行にならない（00043 の一意索引）。
   */
  reservePending?(runKey: string, companyIds: string[]): Promise<{ ok: boolean; error?: string }>;

  /**
   * 1社の結末を**その場で**確定する（発注 ⑥J-4）。
   *
   * 最後にまとめて書くと、**書く前に落ちた社が全部消える。**
   */
  finishCompany?(
    runKey: string,
    companyId: string,
    outcome: string,
    reason?: string,
    /** `false` なら `finished_at` を入れない（時間切れ。次の再開で拾い直す） */
    finished?: boolean,
  ): Promise<{ ok: boolean; error?: string }>;

  /**
   * この `run_key` の実行がどこまで進んでいるかを引く（発注 ⑥J-4）。**再開の入口。**
   *
   * **`total` と `unfinished` を別々に返す。**
   * 未完了が0件であることは、「まだ始めていない」と「全部終わった」の両方を意味する。
   * 区別できないと、**再開の cron が毎回3社を最初からやり直す**
   * （2026-09-12 の本番ログで実測。毎朝5回ずつ走っていた）。
   *
   * 引けなければ `null` を返す。**0件と区別する**——「全部終わっている」と
   * 「引けなかった」を同じ顔にすると、再開が黙って何もしなくなる。
   */
  listRunState?(runKey: string): Promise<{ total: number; unfinished: string[] } | null>;
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
  /** 購読が無いので送らなかった会社数（B-4）。**0件でも必ず出す** */
  skipped_not_entitled: number;
  /**
   * `sending` のまま固まっていて、この実行で `failed` に倒した行数（発注 B-1）。
   * **0件でも必ず出す。** 「掃除が要らなかった」と「掃除が走らなかった」は別である
   */
  stale_swept: number;
  /**
   * 再送の上限（3回）に達したので `abandoned` に移した行数（発注 B-3）。
   * **黙って諦めない。** 翌朝の要約に出す
   */
  abandoned: number;
  /**
   * この実行が対象にしている期間の鍵（発注 ⑥J-4）。再開が同じ日ぶんを拾うのに使う
   */
  run_key?: string;
  /**
   * 締切に達して**手を付けずに残した**会社数（発注 ⑥J-4）。
   * **0件でも必ず出す。** 残した事実が見えないと、再開が要ることに気づけない
   */
  deferred_by_deadline: number;
  /** 90秒で返ってこなかった会社数（発注 ⑥J-4）。**失敗と分ける** */
  timed_out: number;
  /** 再開として走ったか（既に終わった会社を飛ばしたか） */
  resumed: boolean;
  /**
   * 会社の一覧を取り切れたか（B-5）。**取り切れていないなら non-2xx。**
   * 一部だけ配って 200 を返すと、届かなかった会社が記録にも残らない
   */
  truncated?: boolean;
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
  // **取り切れていないなら、配ったぶんを数えても意味が無い**（B-5）。
  // 一部だけ配って 200 を返すと、届かなかった会社が記録にも残らない
  const truncated = deps.targetsTruncated === true;
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
    skipped_not_entitled: 0,
    stale_swept: 0,
    abandoned: 0,
    deferred_by_deadline: 0,
    timed_out: 0,
    resumed: false,
    recorded: false,
    ...(truncated ? { truncated: true } : {}),
  };

  const records: DispatchRecord[] = [];
  const now = new Date();

  // **配る前に掃除する**（発注 B-1）。倒した行はこの実行の再送対象になる。
  // 掃除の失敗で配信を止めない——取りこぼしを拾う機能であって、前提ではない
  if (deps.sweepStaleSending) {
    const swept = await deps.sweepStaleSending(now);
    summary.stale_swept = swept.swept;
    summary.abandoned = swept.abandoned;
    if (swept.error) console.error("dispatch: sending の掃除に失敗:", swept.error);
  }

  // 環境変数はここで1回だけ読む。**分岐の材料を関数の外に置かない**
  const enforceEntitlement = deps.enforceEntitlement === true;

  // ── 再開できる形にする（発注 ⑥J-4）──
  //
  // **記録を最後にまとめて書くと、途中で落ちた実行は1行も残さない。**
  // 先に `pending` を書いておけば、落ちても「誰が未処理か」が残る。
  const runKey = runKeyOf({ kind, now });
  const resumable = Boolean(deps.reservePending && deps.finishCompany);
  summary.run_key = runKey;

  let pending = targets;
  if (resumable) {
    // 既に終わった会社を飛ばす。**2通目を出さない**のはここである
    const state = deps.listRunState ? await deps.listRunState(runKey) : null;
    if (state !== null && state !== undefined) {
      const stillOpen = new Set(state.unfinished);
      // **「行が1行も無い」が初回である。** 未完了が0件でも、行があるなら
      // それは「全部終わった」——最初からやり直してはいけない
      const isFirstRun = state.total === 0;
      if (!isFirstRun) {
        pending = targets.filter((t) => stillOpen.has(t.companyId));
        summary.resumed = pending.length < targets.length;
      }
    }

    const reserved = await deps.reservePending!(
      runKey,
      pending.map((t) => t.companyId),
    );
    // **予約に失敗しても配る。** 記録の失敗で配信を止めない（S-2-6 と同じ判断）
    if (!reserved.ok) console.error("dispatch: pending の予約に失敗:", reserved.error);
  }

  const startedAt = now.getTime();

  /**
   * 会社1社の結末を残す。**その場で確定するのが本体で、`records` は控えである。**
   *
   * 最後にまとめて書く形だけだと、**書く前に落ちた社が全部消える。**
   * `finishCompany` がある実行では即座に確定し、無い実行（既存の試験など）は
   * 従来どおり `records` にだけ積む。
   */
  const settle = async (
    companyId: string,
    outcome: string,
    reason?: string,
    /**
     * **`false` にすると `finished_at` を入れない。** 時間切れの行がこれで、
     * 次の再開でもう一度拾われる（発注 ⑥J-4）
     */
    finished = true,
  ) => {
    records.push({
      kind: "company",
      dispatch: kind,
      companyId,
      outcome,
      ...(reason ? { reason } : {}),
    } as DispatchRecord);
    if (!deps.finishCompany) return;
    const done = await deps.finishCompany(runKey, companyId, outcome, reason, finished);
    // **記録の失敗で配信を止めない。** ただし黙らない
    if (!done.ok) console.error(`dispatch: ${companyId} の結末を書けなかった:`, done.error);
  };

  for (const target of pending) {
    // **残り時間が1社分に満たなければ、始めない**（発注 ⑥J-4）。
    // 始めてから締切に当たると `running` の行が残る。始めなければ `pending` のままで、
    // **「触っていない」と言い切れる**
    if (resumable && shouldStopForDeadline(startedAt, Date.now())) {
      summary.deferred_by_deadline = pending.length - pending.indexOf(target);
      console.warn(
        `[sentio:dispatch] 締切に達したので ${summary.deferred_by_deadline} 社を pending のまま残す ` +
          `run_key=${runKey} kind=${kind}`,
      );
      break;
    }

    const plan = planCompany(target, kind, now, enforceEntitlement);

    // 連携ゼロの会社に空のパルスを送らない（CD-1-2）／宛先が無ければ呼ばない（CD-1-3）。
    // **落とした事実は記録に残す**（PS-8）
    if (plan.action === "skip") {
      if (plan.outcome === "skipped_no_connection") summary.skipped_no_connection++;
      else if (plan.outcome === "skipped_not_entitled") summary.skipped_not_entitled++;
      else summary.skipped_no_email++;
      await settle(target.companyId, plan.outcome);
      continue;
    }

    // **送らなかった日も残す**（PS-9f）。「送り損ねた」（failed_deliver）と別の値にしてある
    if (plan.action === "suppress") {
      summary.reconnect_suppressed++;
      await settle(target.companyId, plan.outcome, plan.reason);
      continue;
    }

    // **生きている源が1つも無い**会社には、再連携のお願いだけを送る（PS-9b）。
    //
    // **PS-9c は 2026-09-13 に改訂した**（`docs/product/ps-9c-revision.md`）。
    // 旧: 取り込みが止まっている**会社**には `state-baselines` も `run-sense` も呼ばない。
    // 新: 取り込みが止まっている**源**の値を、今の状態として提示しない。
    //
    // 生きている源がある会社はここに来ない（`planCompany` が `deliver` を返す）。
    // ここに来るのは源が全部止まっている会社だけなので、**この経路は LLM へ入らない**
    // という旧 PS-9c の担保はそのまま残る
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
        await settle(target.companyId, "reconnect_notice");
      } else {
        summary.failed++;
        await settle(target.companyId, "failed_deliver", `status_${notice.status}`);
      }
      continue;
    }

    // **源の情報を受け手へ渡す**（PS-9c の改訂）。受け手は止まっている源の
    // 値を今の状態として使わない。**渡さなければ従来どおり全部を使う**
    const sourceBody =
      plan.action === "deliver" && plan.live
        ? {
            live_sources: plan.live,
            stopped_sources: (plan.stopped ?? []).map((st) => ({
              provider: st.provider,
              status: st.status,
              last_ingested_at: st.lastIngestedAt,
            })),
          }
        : {};

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
      const state = await deps.invoke("state-baselines", {
        company_id: target.companyId,
        ...sourceBody,
      });
      if (!state.ok) {
        // **State の失敗で Sense も配信も止めない**（SB-D2）。
        // 止めると、ベースラインが崩れた日に毎朝のパルスごと消える。
        // ただし黙って進めない。失敗として数え、non-2xx に効かせる
        summary.state_failed++;
        summary.failed++;
        await settle(target.companyId, "failed_state", `status_${state.status}`);
      }

      const sense = await deps.invoke("run-sense", {
        company_id: target.companyId,
        ...sourceBody,
      });
      if (!sense.ok) {
        // **sense の失敗で配信を止めない**（CD-2-4）。ただし失敗として数える
        summary.sense_failed++;
        summary.failed++;
        await settle(target.companyId, "failed_sense", `status_${sense.status}`);
      }
    }

    const deliverFn = kind === "daily" ? "deliver-pulse" : "deliver-weekly";
    const delivered = await deps.invoke(deliverFn, {
      company_id: target.companyId,
      email: target.email,
      ...sourceBody,
    });

    if (delivered.ok) {
      summary.delivered++;
      await settle(target.companyId, "delivered");
    } else if (delivered.status === 0) {
      // **返事が無かった**（90秒で切った）。**「送れなかった」と分ける**——
      // 時間切れは相手が生きている可能性があり、次の再開でもう一度試す価値がある
      summary.timed_out++;
      summary.failed++;
      // **`finished_at` を入れない。** 次の再開でもう一度試す
      await settle(target.companyId, "timeout", "deliver_timeout", false);
    } else {
      summary.failed++;
      await settle(target.companyId, "failed_deliver", `status_${delivered.status}`);
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
  // **取り切れなかった日も non-2xx にする**（B-5）。
  // 配れたぶんだけ数えて 200 を返すと、届かなかった会社が誰にも見えない
  const failed = summary.failed > 0 || billingProblem || !summary.recorded || truncated;
  return { status: failed ? 502 : 200, body: { ...summary } };
}
