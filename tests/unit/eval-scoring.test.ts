/**
 * 評価スイートの採点ロジック（契約 `docs/contracts/slice-eval-repair.md`・スライスE）。
 *
 * **ここは採点器そのものの検査である。** 現行 Scanner の成績は `tests/eval/engine.test.ts` が測る。
 * 採点器を実データから切り離して、手で作った候補・仕込みで陽性/陰性の両方を押さえる。
 *
 * 直す前の D1 は `c.scanType === signal.scanType` しか見ておらず、
 * **仕込みイベントと無関係な候補でも型さえ合えば検知扱いになっていた**（E-1-3）。
 * さらに同じ型の仕込みが2件あると、**候補1件で2件とも検知扱いになっていた**（E-1-2）。
 */

import { describe, it, expect } from "vitest";
import type { PlantedSignal } from "../../scripts/generate-synthetic-company";
import type { ScanCandidate } from "../../src/sense/scanner";
import { countDetectedSignals, countFalsePositives } from "../eval/scoring";

function signal(id: number, scanType: string, eventIds: string[]): PlantedSignal {
  return { id, label: `signal-${id}`, type: "positive", scanType, eventIds };
}

function candidate(scanType: ScanCandidate["scanType"], eventIds: string[]): ScanCandidate {
  return {
    scanType,
    source: "test",
    suggestedUrgency: "weekly",
    evidence_event_ids: eventIds,
    description: "test candidate",
    score: 1,
  };
}

describe("評価スイートの採点（スライスE）", () => {
  it("E-1-1: 型が一致し、証拠が仕込みイベントと交差する候補を検知と数える", () => {
    const signals = [signal(1, "trend", ["ev_a", "ev_b"])];
    const candidates = [candidate("trend", ["ev_b", "ev_zzz"])];

    expect(countDetectedSignals(signals, candidates).detected).toBe(1);
  });

  it("E-1-3（陰性コントロール）: 仕込みイベントを1つも含まない候補は、型が合っていても検知に数えない", () => {
    const signals = [signal(1, "trend", ["ev_a", "ev_b"])];
    // 型は一致しているが、証拠は無関係なイベントだけ
    const candidates = [candidate("trend", ["ev_unrelated_1", "ev_unrelated_2"])];

    expect(countDetectedSignals(signals, candidates).detected).toBe(0);
  });

  it("E-1-2（陰性コントロール）: 同じ scanType の仕込み2件を、候補1件で2件とも検知扱いにしない", () => {
    // これが直す前に起きていた誤りそのもの。trend が2件あると 1候補で 2/2 と採点していた
    const signals = [signal(1, "trend", ["ev_a"]), signal(4, "trend", ["ev_b"])];
    const candidates = [candidate("trend", ["ev_a"])];

    const result = countDetectedSignals(signals, candidates);
    expect(result.detected).toBe(1);
    expect(result.matched.map((m) => m.signalId)).toEqual([1]);
  });

  it("E-1-2: 1つの候補が両方の仕込みイベントを参照していても、数えるのは1件まで", () => {
    const signals = [signal(1, "trend", ["ev_a"]), signal(4, "trend", ["ev_b"])];
    const candidates = [candidate("trend", ["ev_a", "ev_b"])];

    expect(countDetectedSignals(signals, candidates).detected).toBe(1);
  });

  it("E-1-2: 候補が2件あれば2件とも数える（陽性コントロール）", () => {
    // 1対1制約が「常に1件しか数えない」実装になっていないことを確かめる
    const signals = [signal(1, "trend", ["ev_a"]), signal(4, "trend", ["ev_b"])];
    const candidates = [candidate("trend", ["ev_a"]), candidate("trend", ["ev_b"])];

    expect(countDetectedSignals(signals, candidates).detected).toBe(2);
  });

  it("E-2-1: 誤検知は「証拠が仕込み陽性を1つも含まない候補」で数える", () => {
    const signals = [signal(1, "trend", ["ev_a"])];
    const candidates = [
      candidate("trend", ["ev_a"]), // 仕込みに当たっている＝誤検知ではない
      candidate("deviation", ["ev_noise_1"]), // 仕込みと無関係＝誤検知
      candidate("silence", ["ev_noise_2"]), // 同上
    ];

    const fp = countFalsePositives(signals, candidates);
    expect(fp.count).toBe(2);
    expect(fp.candidates.map((c) => c.scanType).sort()).toEqual(["deviation", "silence"]);
  });

  it("E-2-1: 型が仕込みの集合外でも、証拠が仕込みに当たっていれば誤検知にしない", () => {
    // 直す前の型ベース定義との違いがここに出る。
    // Scanner が ④（trend として仕込んだ残業漸増）を deviation と名乗って出しているのが実例
    const signals = [signal(4, "trend", ["ev_overtime"])];
    const candidates = [candidate("deviation", ["ev_overtime"])];

    expect(countFalsePositives(signals, candidates).count).toBe(0);
  });
});
