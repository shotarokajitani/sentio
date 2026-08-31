/**
 * 評価スイートの採点（契約 `docs/contracts/slice-eval-repair.md`・E-D1 / E-D2）。
 *
 * **型の一致だけで検知扱いにしない。** 直す前の D1 は
 * `c.scanType === signal.scanType` しか見ておらず、コメントが宣言していた
 * 「and references its events」を実装していなかった。
 * 仕込み陽性7件の `scanType` は5種類しかないため、
 * **正しい型の候補が5件あれば 7/7 と採点される**状態だった。
 *
 * `PlantedSignal.eventIds` と `ScanCandidate.evidence_event_ids` は最初から在る。
 * 突き合わせに必要なデータは揃っていて、使っていなかっただけである。
 */

import type { PlantedSignal } from "../../scripts/generate-synthetic-company";
import type { ScanCandidate } from "@edge/_shared/scan";

export interface SignalMatch {
  signalId: number;
  /** 何番目の候補が当たったか。1候補が2つの signal に使い回されないことの根拠 */
  candidateIndex: number;
  /** 証拠として重なったイベントID */
  overlap: string[];
}

export interface DetectionResult {
  detected: number;
  matched: SignalMatch[];
  missed: PlantedSignal[];
}

/**
 * 検知の判定（E-1-1 / E-1-2 / E-1-3）。
 *
 * 条件は2つとも必要である。
 *
 * 1. `scanType` が一致すること
 * 2. **候補の証拠が、その signal の仕込みイベントを1つ以上含むこと**
 *
 * さらに **1つの候補は最大1つの signal にしか使えない**（E-1-2）。
 * これが無いと、同じ型の仕込みが2件あるときに候補1件で2件とも検知扱いになる。
 * 貪欲に前から割り当てる。仕込みは高々7件・候補も十数件なので、
 * 最大マッチングを厳密に解く必要はない。
 */
export function countDetectedSignals(
  signals: PlantedSignal[],
  candidates: ScanCandidate[],
): DetectionResult {
  const usedCandidates = new Set<number>();
  const matched: SignalMatch[] = [];
  const missed: PlantedSignal[] = [];

  for (const signal of signals) {
    const plantedIds = new Set(signal.eventIds);

    const index = candidates.findIndex((candidate, i) => {
      if (usedCandidates.has(i)) return false;
      if (candidate.scanType !== signal.scanType) return false;
      return candidate.evidence_event_ids.some((id) => plantedIds.has(id));
    });

    if (index < 0) {
      missed.push(signal);
      continue;
    }

    usedCandidates.add(index);
    matched.push({
      signalId: signal.id,
      candidateIndex: index,
      overlap: candidates[index].evidence_event_ids.filter((id) => plantedIds.has(id)),
    });
  }

  return { detected: matched.length, matched, missed };
}

export interface FalsePositiveResult {
  count: number;
  candidates: ScanCandidate[];
}

/**
 * 誤検知の判定（E-2-1）。
 *
 * **証拠が仕込み陽性のイベントを1つも含まない候補**を誤検知と数える。
 * 型ベースの定義はやめる。仕込み7件が5種類の `scanType` をほぼ覆っているため、
 * 型で数えると `deviation` の候補を500件吐く Scanner でも誤検知0件と採点されてしまう。
 *
 * 型が仕込みと違っていても、証拠が仕込みに当たっているなら誤検知ではない。
 * 現行 Scanner は④（`trend` として仕込んだ残業漸増）を `deviation` と名乗って出しており、
 * それは「見つけているが名前が違う」であって「無いものを見た」ではない。
 */
export function countFalsePositives(
  signals: PlantedSignal[],
  candidates: ScanCandidate[],
): FalsePositiveResult {
  const plantedIds = new Set(signals.flatMap((s) => s.eventIds));
  const falsePositives = candidates.filter(
    (c) => !c.evidence_event_ids.some((id) => plantedIds.has(id)),
  );
  return { count: falsePositives.length, candidates: falsePositives };
}
