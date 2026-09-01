/**
 * `check:dual-impl` の検査（契約 スライスCH の監査由来・2026-08-31）。
 *
 * **実物のリポジトリだけを入力にすると、全部緑のとき検査器の故障が見えない。**
 * したがって固定フィクスチャで陰性コントロールを持つ
 * （`.claude/rules/ci-coverage.md` が `check:ci-coverage` に課しているのと同じ作法）。
 *
 * 本命は `undeclared` である。**新しい二重実装が黙って増えること**を止めるのが
 * この検査器の狙いであり、それが検出できなければ存在意義が無い。
 */
import { describe, it, expect } from "vitest";
import {
  DUAL_IMPL_SPECS,
  collectFunctions,
  pinsBothSides,
  findViolations,
  type DualImplSpec,
} from "../../scripts/check-dual-impl";

/** 宣言どおりに揃っている状態を作る最小のフィクスチャ */
const SPEC: DualImplSpec = {
  fn: "sharedRule",
  src: "src/x/rule.ts",
  edge: "supabase/functions/_shared/rule.ts",
  pinnedBy: "tests/unit/rule.test.ts",
  reason: "テスト用",
};

const srcMap = new Map([["sharedRule", ["src/x/rule.ts"]]]);
const edgeMap = new Map([["sharedRule", ["supabase/functions/_shared/rule.ts"]]]);
const PINNING_TEST = 'import * as edge from "@edge/_shared/rule";\nimport { r } from "@/x/rule";';

const allExist = () => true;
const readPin = () => PINNING_TEST;

describe("collectFunctions — 定義の拾い方", () => {
  it("export の有無・async の有無にかかわらず拾う", () => {
    const found = collectFunctions(["a.ts"], () =>
      ["export function alpha() {}", "async function beta() {}", "function gamma() {}"].join("\n"),
    );
    expect([...found.keys()].sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("インデントされた定義（関数の中の関数）も拾う", () => {
    const found = collectFunctions(["a.ts"], () => "  function nested() {}");
    expect(found.has("nested")).toBe(true);
  });

  it("同じ関数を複数のファイルが定義していたら両方を持つ", () => {
    const found = collectFunctions(["a.ts", "b.ts"], () => "export function dup() {}");
    expect(found.get("dup")).toEqual(["a.ts", "b.ts"]);
  });

  it("関数宣言でないものは拾わない（アロー関数・文字列中の function）", () => {
    const found = collectFunctions(["a.ts"], () =>
      ["const arrow = () => {};", 'const s = "function notReal() {}";'].join("\n"),
    );
    expect(found.has("arrow")).toBe(false);
    expect(found.has("notReal")).toBe(false);
  });
});

describe("pinsBothSides — 突合テストの見分け", () => {
  it("陽性: @edge/ と @/ の両方に触れていれば真", () => {
    expect(pinsBothSides(PINNING_TEST)).toBe(true);
  });

  it("陽性: 相対パスの src import でも真", () => {
    expect(pinsBothSides('import "@edge/_shared/r";\nimport "../../src/x/rule";')).toBe(true);
  });

  it("陰性: Edge 側しか見ていなければ偽", () => {
    expect(pinsBothSides('import * as edge from "@edge/_shared/rule";')).toBe(false);
  });

  it("陰性: src 側しか見ていなければ偽", () => {
    expect(pinsBothSides('import { r } from "@/x/rule";')).toBe(false);
  });
});

describe("findViolations — 陽性コントロール", () => {
  it("宣言どおりに揃っていれば findings は0件", () => {
    expect(findViolations([SPEC], srcMap, edgeMap, readPin, allExist)).toEqual([]);
  });

  it("止め具なし（pinnedBy: null）を明示的に認めた宣言も通す", () => {
    const noPin = { ...SPEC, pinnedBy: null };
    expect(findViolations([noPin], srcMap, edgeMap, readPin, allExist)).toEqual([]);
  });
});

describe("findViolations — 陰性コントロール（**これが本体**）", () => {
  it("undeclared: 両側に同名があるのに宣言が無ければ赤くする", () => {
    const findings = findViolations([], srcMap, edgeMap, readPin, allExist);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ fn: "sharedRule", reason: "undeclared" });
    // どこにあるかを出さないと直せない
    expect(findings[0].detail).toContain("src/x/rule.ts");
    expect(findings[0].detail).toContain("supabase/functions/_shared/rule.ts");
  });

  it("undeclared: src 側にしか無いものは対象外（二重実装ではない）", () => {
    const onlySrc = new Map([["soloFn", ["src/x/solo.ts"]]]);
    expect(findViolations([], onlySrc, new Map(), readPin, allExist)).toEqual([]);
  });

  it("dangling: 二重実装が解消されたのに宣言が残っていれば赤くする", () => {
    const findings = findViolations([SPEC], new Map(), edgeMap, readPin, allExist);
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toBe("dangling");
  });

  it("missing-file: 宣言したファイルが消えていれば赤くする（改名・移動）", () => {
    const findings = findViolations(
      [SPEC],
      srcMap,
      edgeMap,
      readPin,
      (p) => p !== "supabase/functions/_shared/rule.ts",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toBe("missing-file");
    expect(findings[0].detail).toContain("supabase/functions/_shared/rule.ts");
  });

  it("missing-pin: 止め具を宣言したのに片側しか見ていなければ赤くする", () => {
    const findings = findViolations(
      [SPEC],
      srcMap,
      edgeMap,
      () => 'import * as edge from "@edge/_shared/rule";',
      allExist,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toBe("missing-pin");
  });

  it("missing-pin: 止め具のファイル自体が無ければ赤くする", () => {
    const findings = findViolations(
      [SPEC],
      srcMap,
      edgeMap,
      readPin,
      (p) => p !== "tests/unit/rule.test.ts",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toBe("missing-pin");
  });
});

describe("実物の宣言", () => {
  it("空でない（0件で緑になるのは検査の空洞そのもの）", () => {
    expect(DUAL_IMPL_SPECS.length).toBeGreaterThan(0);
  });

  it("同じ関数を二重に宣言していない", () => {
    const names = DUAL_IMPL_SPECS.map((s) => s.fn);
    expect(new Set(names).size).toBe(names.length);
  });

  it("すべての宣言に理由が書いてある（止め具が無い場合はなぜ無くてよいか）", () => {
    for (const s of DUAL_IMPL_SPECS) {
      expect(s.reason.trim().length, s.fn).toBeGreaterThan(10);
    }
  });

  it("src 側は src/ を、edge 側は supabase/functions/ を指している", () => {
    for (const s of DUAL_IMPL_SPECS) {
      expect(s.src.startsWith("src/"), s.fn).toBe(true);
      expect(s.edge.startsWith("supabase/functions/"), s.fn).toBe(true);
    }
  });
});
