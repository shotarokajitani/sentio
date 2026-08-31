/**
 * `eval/golden/**` のローダ（スライスE・E-D3）。
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
