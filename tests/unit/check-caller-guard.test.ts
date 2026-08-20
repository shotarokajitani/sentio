import { describe, it, expect } from "vitest";
import { parseDeployTargets, findUnguarded } from "../../scripts/check-caller-guard";

/**
 * S-4-8 / S-4-9 の陽性・陰性コントロール。
 *
 * 新しい Function を足すときに `resolveCaller` を呼び忘れる未来は確実に来る。
 * そのとき静かに穴が空くのを、レビューではなく機械で止める。
 * 検査の突合先を deploy.yml にしているのは、「デプロイされているのに封鎖されていない」を
 * 検出したいためで、`supabase/functions/` のディレクトリ一覧では
 * 「デプロイされていない実験用ディレクトリ」まで巻き込んでしまう。
 */

const DEPLOY_YML = `
name: deploy
jobs:
  deploy-functions:
    steps:
      - uses: supabase/setup-cli@v1
      - name: Deploy scan
        run: supabase functions deploy scan --no-verify-jwt --project-ref "$SUPABASE_PROJECT_REF"
      - name: Deploy run-sense
        run: supabase functions deploy run-sense --project-ref "$SUPABASE_PROJECT_REF"
      - name: Deploy day0
        run: supabase functions deploy day0 --project-ref "$SUPABASE_PROJECT_REF"
`;

const GUARDED = `
import { resolveCaller } from "../_shared/caller.ts";
Deno.serve(async (req) => {
  const caller = await resolveCaller(req, ["internal"]);
  if (!caller.ok) return caller.response;
});
`;

const UNGUARDED = `
Deno.serve(async (req) => {
  const { company_id } = await req.json();
  return new Response(JSON.stringify({ company_id }));
});
`;

describe("parseDeployTargets", () => {
  it("deploy.yml から関数名を抽出する", () => {
    expect(parseDeployTargets(DEPLOY_YML)).toEqual(["scan", "run-sense", "day0"]);
  });

  it("--no-verify-jwt の有無で抽出結果が変わらない", () => {
    const targets = parseDeployTargets(DEPLOY_YML);
    expect(targets).toContain("scan"); // --no-verify-jwt あり
    expect(targets).toContain("day0"); // なし
  });

  it("deploy 対象が1件も取れない deploy.yml は、静かに0件 pass にせず検出できる", () => {
    // 検査対象が空なら常に緑になる。それは検査の空洞なので、呼び出し側が判定できるよう
    // 空配列を返すこと自体を固定しておく（CLI 側で 0件を fail にする）
    expect(parseDeployTargets("name: deploy\njobs: {}\n")).toEqual([]);
  });
});

describe("findUnguarded", () => {
  const reader = (map: Record<string, string>) => (name: string) => map[name] ?? null;

  it("陽性コントロール: 全 Function が resolveCaller を通っていれば violation 0件", () => {
    const result = findUnguarded(
      ["scan", "run-sense"],
      reader({ scan: GUARDED, "run-sense": GUARDED }),
    );
    expect(result).toEqual([]);
  });

  it("陰性コントロール: 封鎖していない Function を1本混ぜると検出する", () => {
    const result = findUnguarded(
      ["scan", "run-sense", "day0"],
      reader({ scan: GUARDED, "run-sense": UNGUARDED, day0: GUARDED }),
    );
    expect(result).toEqual([{ name: "run-sense", reason: "no-resolve-caller" }]);
  });

  it("deploy 対象なのに index.ts が無い場合も violation にする", () => {
    const result = findUnguarded(["scan", "ghost"], reader({ scan: GUARDED }));
    expect(result).toEqual([{ name: "ghost", reason: "missing-file" }]);
  });

  it("コメント内の resolveCaller を封鎖済みと誤認しない", () => {
    const commentedOut = `
      // const caller = await resolveCaller(req, ["internal"]);
      Deno.serve(async (req) => new Response("ok"));
    `;
    const result = findUnguarded(["scan"], reader({ scan: commentedOut }));
    expect(result).toEqual([{ name: "scan", reason: "no-resolve-caller" }]);
  });

  it("import しているだけで呼んでいない Function を封鎖済みと誤認しない", () => {
    const importOnly = `
      import { resolveCaller } from "../_shared/caller.ts";
      Deno.serve(async (req) => new Response("ok"));
    `;
    const result = findUnguarded(["scan"], reader({ scan: importOnly }));
    expect(result).toEqual([{ name: "scan", reason: "no-resolve-caller" }]);
  });
});
