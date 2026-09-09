/**
 * 料金の数字は定数ファイル1か所にしか無い（2026-09-09 決定・検収者）。
 *
 * **値上げのときに直し漏れる面が出ないようにする。** LP・`/legal`・申込前の確認画面が
 * それぞれ数字を持つと、**どれが正しいのか誰にも言えなくなる。**
 *
 * ここが見るのは**表示に使うソース**である。
 * 走査するのは `src/` と `supabase/functions/`（`src/lib/pricing.ts` を除く）。
 * **試験と `scripts/` は走査しない**——この試験自身が禁止語を持つためで、
 * `tests/unit/billing-section.test.ts` の停止点も同じ理由で対象外である。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { SENTIO_PRICE_JPY_TAX_INCLUDED, SENTIO_TRIAL_DAYS } from "@/lib/pricing";

const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIRS = ["src", "supabase/functions"];
const CONSTANTS_FILE = path.join("src", "lib", "pricing.ts");

/** 直書きを禁じる語。**表示の形（3万・30,000）も数字（30000）も同じ扱いにする** */
const FORBIDDEN = ["30000", "30,000", "3万円", "14日"];

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(ROOT, dir))) {
      const rel = path.join(dir, entry);
      if (statSync(path.join(ROOT, rel)).isDirectory()) {
        walk(rel);
        continue;
      }
      if (/\.(ts|tsx)$/.test(entry)) found.push(rel);
    }
  };
  for (const dir of SCAN_DIRS) walk(dir);
  return found;
}

describe("料金の数字は1か所にしか無い", () => {
  it("定数が決定どおりの値である（月額30000円・14日）", () => {
    expect(SENTIO_PRICE_JPY_TAX_INCLUDED).toBe(30000);
    expect(SENTIO_TRIAL_DAYS).toBe(14);
  });

  it("走査対象が空でない（検査器が空振りしていないこと）", () => {
    // **全部緑のとき検査器の故障が見えない**ので、まず対象があることを見る
    expect(sourceFiles().length).toBeGreaterThan(50);
  });

  it("定数ファイル以外のソースに金額と無料期間の数字が現れない", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      if (file === CONSTANTS_FILE) continue;
      const source = readFileSync(path.join(ROOT, file), "utf8");
      for (const literal of FORBIDDEN) {
        if (source.includes(literal)) offenders.push(`${file}: ${literal}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("定数ファイルは料金の定数だけを持つ（雑多な置き場にしない）", () => {
    const source = readFileSync(path.join(ROOT, CONSTANTS_FILE), "utf8");
    const exported = [...source.matchAll(/export const (\w+)/g)].map((m) => m[1]);

    expect(exported).toEqual(["SENTIO_PRICE_JPY_TAX_INCLUDED", "SENTIO_TRIAL_DAYS"]);
  });
});
