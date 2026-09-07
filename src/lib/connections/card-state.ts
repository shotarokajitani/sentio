/**
 * 連携カードの「状態 → 何を出すか」を決める（`/connect` の `SourceRow`）。
 *
 * **判断を JSX から出す。** 画面の中に条件を散らすと、
 * 「状態ごとに主操作は1つ」という原則が守られているかを機械で確かめられない。
 * ここに閉じておけば、原則そのものをテストで固定できる。
 *
 * 置いた原則は2つ（2026-09-07 発注）。
 *
 * 1. **状態ごとに、主操作は1つだけ。**
 * 2. **取り消しのきかない操作と、回復する操作を、同じ高さに並べない。**
 *    「連携を解除」は取り消せない（トークンを破棄し、取り込んだデータを消す）。
 *    したがって**主操作にはならない。** 畳んだ先に置く。
 */

import type { ConnectionRow } from "./overview";

/** カードの状態。**新しい状態を増やさない**（既存の見せ方を整えるだけ） */
export type CardKind = "unconnected" | "connected" | "needs_reauth";

/** 畳んだ先に置く操作。いまは解除だけ */
export type CardMenuAction = "disconnect";

export interface CardActions {
  kind: CardKind;
  /**
   * 主操作。**1状態につき最大1つ。** `null` は「主操作を置かない」。
   * 正常につながっているときに押させるものは無い、が設計の答えである。
   */
  primary: "connect" | "reconnect" | null;
  /**
   * 畳んだ操作。**空なら `…` 自体を出さない**（中身の無いメニューを開かせない）。
   * freee の行がこれに当たる（解除 UI を渡していないため空になる）。
   */
  menu: CardMenuAction[];
}

/**
 * 再連携が要る状態。
 *
 * `revoked`（連携先で取り消された）と `reauth_required`（更新に失敗した）は
 * **DB では区別して残す**が、**画面では同じ1つの状態**として見せる
 * （U-3・2026-08-27 確定。利用者にできることはどちらも「再接続」だけである）。
 */
const NEEDS_REAUTH = new Set(["reauth_required", "revoked"]);

export function cardActions(
  connection: Pick<ConnectionRow, "status"> | undefined | null,
  /** その行に解除 UI が渡っているか（渡っていない行では畳む対象が無い） */
  canDisconnect: boolean,
): CardActions {
  if (!connection) {
    // 行が無い＝未連携。**解除は存在しない**ので畳む対象も無い
    return { kind: "unconnected", primary: "connect", menu: [] };
  }

  const menu: CardMenuAction[] = canDisconnect ? ["disconnect"] : [];

  if (NEEDS_REAUTH.has(connection.status)) {
    return { kind: "needs_reauth", primary: "reconnect", menu };
  }

  // **`pending` はここに落ちる**（DB 既定値。`00007:10`）。
  // 2026-09-07 の実測では、これを書くコードは1つも無い（今回は挙動を変えない）。
  return { kind: "connected", primary: null, menu };
}

/**
 * 「最終同期が古い」と見なす境目。**定数1つで持つ。環境変数にしない。**
 *
 * 取り込みは `sync-connections` の cron で UTC 0/6/12/18 ＝ **6時間ごと**
 * （`docs/checklists/cron-jobs.yml`）。12時間を超えているということは
 * **2回続けて取り込めていない**ということである。
 *
 * 1回落ちただけで鳴らさないのは、通常の揺らぎで鳴ると**鳴っていること自体に慣れる**ため。
 * 24時間を採らないのは、丸1日気づけないのが毎朝のパルスという設計と噛み合わないため。
 *
 * **これは表示の閾値であって、取り込みの契約ではない。** 鳴りすぎ・鳴らなすぎが
 * 分かったら事実を添えて挙げること（2026-09-07 発注 1-4）。
 */
export const STALE_SYNC_HOURS = 12;

export interface SyncFreshness {
  /** 古いか。**古いときだけ**表示を強める */
  stale: boolean;
  /** 「4日前」のような相対表記。`null` は一度も同期していない */
  relative: string | null;
}

/**
 * 最終同期の鮮度。**時刻の差だけで決める**（タイムゾーンに依存しない）。
 *
 * 未来の時刻は「たった今」に丸める。時計のずれで「-1時間前」と出すより無害である。
 */
export function syncFreshness(
  lastRefresh: string | null | undefined,
  now: Date = new Date(),
): SyncFreshness {
  if (!lastRefresh) return { stale: false, relative: null };

  const then = new Date(lastRefresh);
  if (Number.isNaN(then.getTime())) return { stale: false, relative: null };

  const diffMs = now.getTime() - then.getTime();
  const hours = diffMs / (60 * 60 * 1000);

  return { stale: hours >= STALE_SYNC_HOURS, relative: relativeAge(diffMs) };
}

/** 「たった今」「3時間前」「4日前」。**桁を増やさない**（分単位までは要らない） */
function relativeAge(diffMs: number): string {
  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  if (hours < 1) return "たった今";
  if (hours < 24) return `${hours}時間前`;
  return `${Math.floor(hours / 24)}日前`;
}
