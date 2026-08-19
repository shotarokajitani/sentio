/**
 * narratives の confidence の時間減衰（契約 S-1-3 / `.claude/rules/state.md`）。
 *
 * **修復前、減衰関数は `state-narratives` に定義されていたが1度も呼ばれていなかった**
 * （デッドコード。2026-08-20 実測）。しかも `updated_at` という**実在しない列**を
 * 引数に取る形で書かれていたため、仮に呼んでも動かなかった。
 * 「時間減衰がある」は仕様上の主張としてだけ存在し、実体が無かった。
 *
 * 保存する `confidence` は**最後に確認した時点の値**で、
 * 実効値は `last_confirmed_at` からの経過で減る。**減衰は読む側で計算する。**
 * 保存値を定期的に書き換える方式を採らないのは、書き換えるジョブが止まった瞬間に
 * 「古い値が新しい顔をして残る」ためで、それは State 層で最も避けたい形である。
 */

/** 半減期。30日で 0.5 になる。 */
export const HALF_LIFE_DAYS = 30;

const DECAY_LAMBDA = Math.LN2 / HALF_LIFE_DAYS;

/**
 * 最後に確認した時点の confidence と、その時刻から、現時点の実効 confidence を出す。
 *
 * `lastConfirmedAt` が読めない場合は **`stored` をそのまま返す**（減らさない）。
 * ここで 0 に落とすと、時刻が壊れている行が「無かったこと」になり、
 * 訂正で 0 にした行と区別がつかなくなる。
 */
export function decayedConfidence(
  stored: number,
  lastConfirmedAt: string | null | undefined,
  now: Date,
): number {
  if (!lastConfirmedAt) return stored;

  const confirmed = new Date(lastConfirmedAt).getTime();
  if (Number.isNaN(confirmed)) return stored;

  const days = (now.getTime() - confirmed) / (24 * 60 * 60 * 1000);
  // 未来日時（時計ずれ）で 1 を超えさせない
  if (days <= 0) return stored;

  return stored * Math.exp(-DECAY_LAMBDA * days);
}
