/**
 * Edge Function の「配る」「消す」「知らないものが居る」を突き合わせる（発注 F）。
 *
 * ## なぜ作ったか
 *
 * **本番に、リポジトリのどこにも無い関数が20本 ACTIVE で残っていた**
 * （2026-09-10・`list_edge_functions` の実測）。4月に作られたもので、
 * `entrypoint_path` が `/tmp/user_fn_…` になっているのが目印である。
 *
 * `deploy.yml` は「配る」しかしていなかったので、**配っていない関数が本番に
 * 残っていても誰も見なかった。** `check:caller-guard` も `supabase/functions/`
 * 配下しか走査しないため、リポジトリの外は全部が射程外だった。
 *
 * 残っていたものには `stripe-webhook` / `create-checkout` / `create-portal-link` /
 * `process-answer` が含まれる。**課金と入力の口が、誰も見ていない実装で開いていた。**
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  checkLive,
  checkLocal,
  deployedSlugs,
  functionDirs,
  loadEdgeDeclaration,
} from "../../scripts/check-edge-functions";

const root = path.resolve(__dirname, "../..");
const decl = loadEdgeDeclaration(path.join(root, "docs/checklists/edge-functions.yml"));
const dirs = functionDirs(path.join(root, "supabase/functions"));
const workflow = readFileSync(path.join(root, ".github/workflows/deploy.yml"), "utf8");
const deployed = deployedSlugs(workflow);

describe("宣言・ディレクトリ・deploy.yml が一致する", () => {
  it("実物どうしで findings が0件（陽性コントロール）", () => {
    expect(checkLocal(decl, dirs, deployed)).toEqual([]);
  });

  it("**陰性**: 関数ディレクトリを宣言に足し忘れると赤くなる", () => {
    const out = checkLocal(decl, [...dirs, "new-function"], deployed);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("[undeclared-dir]");
  });

  it("**陰性**: 宣言に居るのにディレクトリが無ければ赤くなる", () => {
    const out = checkLocal(decl, dirs.filter((d) => d !== "day0"), deployed);
    expect(out.some((f) => f.includes("[dangling]"))).toBe(true);
  });

  it("**陰性**: deploy.yml から1本抜けると赤くなる（配り忘れ）", () => {
    const out = checkLocal(decl, dirs, deployed.filter((d) => d !== "deliver-pulse"));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("[not-deployed]");
    expect(out[0]).toContain("deliver-pulse");
  });

  it("**陰性**: 配るものと消すものが重なったら赤くなる（配った直後に消す事故）", () => {
    const broken = { ...decl, remove: [...decl.remove, "day0"] };
    const out = checkLocal(broken, dirs, deployed);
    expect(out.some((f) => f.includes("[conflict]") && f.includes("day0"))).toBe(true);
  });

  it("CI 専用の関数は本番に配らない（実LLMを呼ばない経路を本番に作らない）", () => {
    expect(decl.ci_only).toEqual(["investigate-stub"]);
    expect(deployed).not.toContain("investigate-stub");
  });
});

describe("本番に知らない関数が居たら赤くする", () => {
  it("配る一覧と消す一覧に載っているものだけなら0件", () => {
    expect(checkLive(decl, [...decl.deploy, ...decl.remove])).toEqual([]);
  });

  it("**陰性**: どちらにも無い関数が本番に居たら赤くなる（今回と同じ形の再発）", () => {
    const out = checkLive(decl, [...decl.deploy, "mystery-function"]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("[unknown-in-production]");
    expect(out[0]).toContain("mystery-function");
  });

  it("消す一覧の20本が本番に残っていても、それ自体は赤にしない（削除の段が消す）", () => {
    expect(checkLive(decl, decl.remove)).toEqual([]);
  });
});

describe("削除の段の作法", () => {
  it("消す一覧はワークフローに直書きせず、宣言から引く", () => {
    // 2か所に書くと必ずずれる（00036 と同じ形）
    expect(workflow).toContain("--list-remove");
    for (const slug of decl.remove) {
      expect(workflow, slug).not.toContain(`functions delete ${slug}`);
    }
  });

  it("**存在しない slug の削除はジョブを落とさない**（冪等）", () => {
    // 再実行のたびに赤くなると、この段そのものが「いつも赤いから見ない」ものになる
    expect(workflow).toContain("not found|does not exist");
  });

  it("それ以外の失敗は握りつぶさない", () => {
    expect(workflow).toContain("::error::");
    expect(workflow).toContain("exit $failed");
  });

  it("消す20本が、4月の旧関数の一覧と一致する", () => {
    expect(decl.remove).toHaveLength(20);
    for (const slug of ["stripe-webhook", "create-checkout", "create-portal-link", "process-answer"]) {
      expect(decl.remove, slug).toContain(slug);
    }
  });
});
