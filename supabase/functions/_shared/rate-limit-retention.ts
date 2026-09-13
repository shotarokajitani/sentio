/**
 * `api_rate_limits`（00049）の古い窓を消す方針（2026-09-13 の点検・PR-2b）。
 *
 * **Edge 側にだけ置く。** `retention.ts` は `src/lib/retention/policy.ts` の写しで、
 * こちらは Next 側に対になる実装が無い（消すのは retention-purge だけ）。
 *
 * ## なぜ消すか
 *
 * `ip:<addr>` の行には送信元の IP アドレスが残る。窓は最長1日なので、
 * 2日より前の窓は数え終わっていて、判定には二度と使われない。
 *
 * ## 規律は events の削除と同じ
 *
 * - **既定は数えるだけ**（`dry_run`）
 * - 数えられなければ消さない（`uncounted`）
 * - 上限を超えたら消さない（`over-limit`）
 *
 * 会社ごとに絞る削除ではないので、`evaluateDeletion` の `unscoped` は使わない。
 * **絞り込みは `window_start < cutoff` の1条件である。**
 */
import type { PurgePlan } from "./retention.ts";

/** 窓の始まりがこれより古い行を消す（窓は最長1日。2日前なら数え終わっている） */
export const RATE_LIMIT_RETENTION_DAYS = 2;

export function rateLimitCutoff(now: Date, days: number = RATE_LIMIT_RETENTION_DAYS): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/** 消すかどうかを決める。**実行はしない。** `dryRun` は引数で受ける（`planPurge` と同じ理由） */
export function planRateLimitPurge(input: {
  counted: number | null;
  max: number;
  dryRun: boolean;
}): PurgePlan {
  if (input.counted === null) return { decision: "blocked", reason: "uncounted", count: 0 };
  if (input.counted > input.max) {
    return { decision: "blocked", reason: "over-limit", count: input.counted };
  }
  if (input.counted === 0) return { decision: "nothing", count: 0 };
  return { decision: input.dryRun ? "dry_run" : "deleted", count: input.counted };
}
