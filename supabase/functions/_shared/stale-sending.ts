/**
 * `sending` のまま固まった行を掃除する（発注 ①-4）。**判断だけを持つ。**
 *
 * ## 何が起きていたか
 *
 * `deliverOnce` は「予約（`sending`）→ 送信 → 更新（`sent` / `failed`）」で動く。
 * **真ん中で落ちると `sending` のまま残る。** Edge Function のタイムアウト、
 * デプロイによる再起動、Resend への接続が返ってこない、のどれでも起きる。
 *
 * `RETRYABLE` は `failed` と `deferred` だけなので、`sending` の行は
 * **二度と再送されない。** `deliverOnce` はこれを「送った可能性がある」（`in-flight`）と
 * 読んで飛ばす。その判断自体は正しい——**送った直後に落ちた場合と区別が付かない**からで、
 * 短い時間なら二重送信のほうが害が大きい。
 *
 * ただし**2時間も `sending` のままなら、送信中ではありえない。**
 * Resend への1回の POST が2時間かかることは無く、Edge Function の上限も遥かに短い。
 * そこまで放置された行は「落ちた」と読んでよい。
 *
 * ## なぜ純関数に分けるか
 *
 * `planPurge` / `planTransientFailure` と同じ形。**壊して赤くできる形にする**ため、
 * 「どの行を倒すか」の判断を I/O から切り離す。
 */

/** これより長く `sending` のままなら、送信中ではありえない */
export const STALE_SENDING_HOURS = 2;

/** 掃除で倒した行に入れる理由（`delivery_log.last_error`・00039） */
export const STALE_SENDING = "stale_sending";

/**
 * 再送を諦めた行の状態。**`failed` と分ける。**
 *
 * `failed` のままだと `RETRYABLE` に当たり続け、毎朝拾っては上限で弾かれる。
 * 拾われないところに移し、**諦めたことを状態として残す。**
 */
export const ABANDONED = "abandoned";

/** 再送の上限。`delivery.ts` の `MAX_SEND_ATTEMPTS` と同じ値をここでも見る */
export const MAX_SEND_ATTEMPTS = 3;

export interface StaleRow {
  id: string;
  status: string;
  attempts: number | null;
  created_at: string | null;
}

export interface StalePlan {
  /** `failed` に倒して、同じ実行で再送に回す行 */
  retry: string[];
  /** 上限に達しているので `abandoned` に移す行 */
  abandon: string[];
}

/**
 * 倒す行を決める。**`sending` 以外は1行も触らない。**
 *
 * `created_at` が読めない行は**触らない**。時刻が分からないものを
 * 「古い」と決めつけると、いま送信中の行を横から倒しうる。
 */
export function planStaleSweep(rows: StaleRow[], now: Date): StalePlan {
  const cutoff = now.getTime() - STALE_SENDING_HOURS * 60 * 60 * 1000;
  const plan: StalePlan = { retry: [], abandon: [] };

  for (const row of rows) {
    if (row.status !== "sending") continue;
    if (!row.created_at) continue;

    const at = Date.parse(row.created_at);
    if (Number.isNaN(at)) continue;
    if (at > cutoff) continue;

    // **上限に達しているなら、倒しても次で弾かれるだけ。** 諦めた側に移す
    const attempts = Number.isFinite(row.attempts) ? (row.attempts as number) : 0;
    if (attempts >= MAX_SEND_ATTEMPTS) plan.abandon.push(row.id);
    else plan.retry.push(row.id);
  }

  return plan;
}
