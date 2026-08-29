/**
 * `eval/golden/**` のローダと、Day0 成果物の検査器（スライスE・E-D3 / E-4-1）。
 *
 * golden は12ケース分の `meta.json` を持ちながら、`engine.test.ts` から
 * **一度も読まれていなかった**。読まれない期待値は文書であって検査ではない。
 * 消す案は採らない（E-D3）。`real-diseno` に残っている学びが失われるため。
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { PlantedSignal } from "../../scripts/generate-synthetic-company";

export interface GoldenMeta {
  id: number;
  lang: string;
  type: "positive" | "negative" | "real";
  scanType: string;
  description: string;
  expected?: Record<string, unknown>;
}

export interface GoldenCase {
  name: string;
  dir: string;
  meta: GoldenMeta;
}

/** `eval/golden/<name>/meta.json` を実際に読む。読めないディレクトリは黙って飛ばさず落とす */
export function loadGoldenCases(root: string): GoldenCase[] {
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  return dirs.map((name) => {
    const dir = join(root, name);
    const metaPath = join(dir, "meta.json");
    if (!existsSync(metaPath)) {
      throw new Error(`eval/golden: meta.json が無い: ${metaPath}`);
    }
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as GoldenMeta;
    for (const key of ["id", "type", "scanType"] as const) {
      if (meta[key] === undefined) {
        throw new Error(`eval/golden: ${name}/meta.json に ${key} が無い`);
      }
    }
    return { name, dir, meta };
  });
}

export interface ComparisonResult {
  problems: string[];
}

/**
 * 仕込み（`generate-synthetic-company`）と golden の突き合わせ（E-3-1）。
 *
 * golden にしか無いケース（`negative-extra-*` / `real-diseno`）は許す。
 * **仕込み側に在るものが golden に無い、または型が食い違う**のを問題として出す。
 * 片方だけ直したときに、期待値と生成物が静かにずれるのを止める。
 */
export function compareGoldenWithPlanted(
  cases: GoldenCase[],
  planted: PlantedSignal[],
): ComparisonResult {
  const byId = new Map(cases.map((c) => [c.meta.id, c]));
  const problems: string[] = [];

  for (const signal of planted) {
    const found = byId.get(signal.id);
    if (!found) {
      problems.push(`仕込み id=${signal.id}（${signal.label}）に対応する golden ケースが無い`);
      continue;
    }
    if (found.meta.type !== signal.type) {
      problems.push(
        `id=${signal.id}: type が食い違う（仕込み=${signal.type} / golden=${found.meta.type}）`,
      );
    }
    // 陰性は golden 側が "none" などを持つので、陽性だけ scanType を突き合わせる
    if (signal.type === "positive" && found.meta.scanType !== signal.scanType) {
      problems.push(
        `id=${signal.id}: scanType が食い違う（仕込み=${signal.scanType} / golden=${found.meta.scanType}）`,
      );
    }
  }

  return { problems };
}

export interface Day0Expectations {
  evaluator_must_run: boolean;
  generation_time_min_ms: number;
  day0_must_contain: Record<string, string[]>;
}

export interface Day0Artifact {
  evaluator_ran: boolean;
  generation_time_ms: number;
  blocks: Record<string, string>;
}

/**
 * Day0 成果物の検査（E-4-1 / E-4-2）。
 *
 * `real-diseno/meta.json` の `a2_misjudgment` は
 * **テンプレ差し込みの Day0 を pass と誤採点した**記録である。
 * 証拠は生成時間135ms（LLM を通っていない）。同じファイルに再発防止条件が
 * 機械検査可能な形で書かれているのに、検査するコードが無かった。
 *
 * **成果物が無いときは fail する。** ここで `null` を pass にすると、
 * 「Day0 を一度も作っていない」状態が緑になる。それは fail-open であり、
 * `tests/integration/report-page.test.ts` の `mode === "fail"` ガードと同じ理由で潰す。
 */
export function checkDay0Artifact(
  expectations: Day0Expectations,
  artifact: Day0Artifact | null,
): { problems: string[] } {
  if (artifact === null) {
    return {
      problems: [
        "Day0 の出力成果物が無い。検査対象が存在しない状態を pass にしない（E-4-2）。" +
          "テンプレ差し込みの Day0 を pass と誤採点した a2_misjudgment と同じ形になる",
      ],
    };
  }

  const problems: string[] = [];

  if (expectations.evaluator_must_run && !artifact.evaluator_ran) {
    problems.push("Evaluator が走っていない（evaluator_must_run: true）");
  }

  if (artifact.generation_time_ms < expectations.generation_time_min_ms) {
    problems.push(
      `生成時間 ${artifact.generation_time_ms}ms が下限 ${expectations.generation_time_min_ms}ms 未満。` +
        "LLM を通っていない疑いがある（135ms の事故と同じ形）",
    );
  }

  for (const [block, required] of Object.entries(expectations.day0_must_contain)) {
    const text = artifact.blocks[block];
    if (text === undefined) {
      problems.push(`ブロック ${block} が成果物に無い`);
      continue;
    }
    for (const term of required) {
      // 「具体的金額or件数or傾向」のような選択肢形式は、どれか1つで満たす
      const alternatives = term.split("or");
      if (!alternatives.some((a) => text.includes(a))) {
        problems.push(`ブロック ${block} に必須語がない: ${term}`);
      }
    }
  }

  return { problems };
}

/** ケースディレクトリの Day0 成果物を読む。**無ければ `null`**（呼び出し側が fail させる） */
export function loadDay0Artifact(caseDir: string): Day0Artifact | null {
  const path = join(caseDir, "day0.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Day0Artifact;
}
