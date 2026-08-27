/**
 * D-4-1: 「API はあるが、どこからも到達しない」を機械で止める検査器の試験。
 *
 * このスライスが生まれた原因そのものが対象である。`disconnect` API は
 * 実装も fail-closed の門も揃っていたのに、**画面にもどこにも呼び出し元が無く**、
 * プライバシーポリシー §6 の約束が実態と食い違っていた。
 * `check:caller-guard` は Edge Function しか見ないので、この形は捕まらない。
 *
 * **実物のソースだけを入力にすると、全部緑のときに検査器の故障が見えない**ので、
 * 固定フィクスチャで陰性コントロールを持つ（`.claude/rules/ci-coverage.md` の作法）。
 */
import { describe, it, expect } from "vitest";
import {
  aliasSpecifier,
  findUnreachable,
  type EndpointSpec,
} from "../../scripts/check-endpoint-callers";

const SPEC: EndpointSpec = {
  id: "disconnect",
  endpoint: "/api/connections/disconnect",
  route: "src/app/api/connections/disconnect/route.ts",
  contract: "D-4-1",
};

const CALLER_FILE = "src/lib/connections/disconnect.ts";
const CALLER_SOURCE = `export const DISCONNECT_ENDPOINT = "/api/connections/disconnect";`;
const IMPORTER_FILE = "src/app/connect/connect-client.tsx";
const IMPORTER_SOURCE = `import { requestDisconnect } from "@/lib/connections/disconnect";`;

describe("aliasSpecifier", () => {
  it("src 配下のパスを @/ 形式の import 指定子に変える", () => {
    expect(aliasSpecifier("src/lib/connections/disconnect.ts")).toBe(
      "@/lib/connections/disconnect",
    );
    expect(aliasSpecifier("src/app/connect/connect-client.tsx")).toBe(
      "@/app/connect/connect-client",
    );
  });

  it("Windows 由来の区切りでも同じ結果になる", () => {
    expect(aliasSpecifier("src\\lib\\connections\\disconnect.ts")).toBe(
      "@/lib/connections/disconnect",
    );
  });
});

describe("findUnreachable — 陽性コントロール", () => {
  it("呼び出し元があり、それが他から import されていれば findings は0件", () => {
    const findings = findUnreachable([SPEC], () => true, [
      { file: CALLER_FILE, source: CALLER_SOURCE },
      { file: IMPORTER_FILE, source: IMPORTER_SOURCE },
    ]);

    expect(findings).toEqual([]);
  });

  it("相対パスの import でも到達していると認める", () => {
    const findings = findUnreachable([SPEC], () => true, [
      { file: CALLER_FILE, source: CALLER_SOURCE },
      {
        file: IMPORTER_FILE,
        source: `import { requestDisconnect } from "../../lib/connections/disconnect";`,
      },
    ]);

    expect(findings).toEqual([]);
  });
});

describe("findUnreachable — 陰性コントロール", () => {
  it("no-caller: どのファイルもエンドポイントに触れていない（このスライス前の状態）", () => {
    const findings = findUnreachable([SPEC], () => true, [
      { file: "src/app/connect/connect-client.tsx", source: `const x = 1;` },
    ]);

    expect(findings).toEqual([{ id: "disconnect", reason: "no-caller" }]);
  });

  it("no-caller: コメントアウトされた呼び出しを到達と誤認しない", () => {
    const findings = findUnreachable([SPEC], () => true, [
      {
        file: CALLER_FILE,
        source: `// const e = "/api/connections/disconnect";\n/* "/api/connections/disconnect" */\nconst x = 1;`,
      },
      { file: IMPORTER_FILE, source: IMPORTER_SOURCE },
    ]);

    expect(findings).toEqual([{ id: "disconnect", reason: "no-caller" }]);
  });

  it("no-importer: 呼び出す実体はあるが、誰もその module を import していない", () => {
    const findings = findUnreachable([SPEC], () => true, [
      { file: CALLER_FILE, source: CALLER_SOURCE },
      { file: IMPORTER_FILE, source: `const x = 1;` },
    ]);

    expect(findings).toEqual([{ id: "disconnect", reason: "no-importer" }]);
  });

  it("no-importer: import 文がコメントアウトされていたら到達と認めない", () => {
    const findings = findUnreachable([SPEC], () => true, [
      { file: CALLER_FILE, source: CALLER_SOURCE },
      {
        file: IMPORTER_FILE,
        source: `// import { requestDisconnect } from "@/lib/connections/disconnect";`,
      },
    ]);

    expect(findings).toEqual([{ id: "disconnect", reason: "no-importer" }]);
  });

  it("missing-route: 宣言した route.ts が存在しない（API 側の改名・削除）", () => {
    const findings = findUnreachable([SPEC], () => false, [
      { file: CALLER_FILE, source: CALLER_SOURCE },
      { file: IMPORTER_FILE, source: IMPORTER_SOURCE },
    ]);

    expect(findings).toEqual([{ id: "disconnect", reason: "missing-route" }]);
  });

  it("呼び出し元が API ルート自身しか無い場合は到達と認めない", () => {
    // 入力側で src/app/api/** を除いてある前提を、検査器の側でも崩さない。
    // 「API が自分自身に言及している」を呼び出し元と読むと検査が空洞になる
    const findings = findUnreachable([SPEC], () => true, [
      { file: "src/app/api/connections/disconnect/route.ts", source: CALLER_SOURCE },
    ]);

    expect(findings).toEqual([{ id: "disconnect", reason: "no-caller" }]);
  });
});
