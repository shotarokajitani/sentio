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
  isConventionFile,
  ENDPOINT_SPECS,
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


/**
 * 2026-08-31 の修理。**宣言が1件しか無いことが穴だった**が、
 * 広げようとすると到達しているエンドポイントまで `no-importer` になった。
 * 原因は2つあり、どちらも「実際には到達しているのに、見方が狭い」形である。
 */
describe("到達の見方（2026-08-31 の修理）", () => {
  const SIBLING_SPEC: EndpointSpec = {
    id: "csv-analyze",
    endpoint: "/api/csv/analyze",
    route: "src/app/api/csv/analyze/route.ts",
    contract: "CH-D2",
  };

  it("兄弟の相対 import（`./connect-client`）を到達と認める", () => {
    const sources = [
      { file: "src/app/connect/connect-client.tsx", source: 'fetch("/api/csv/analyze")' },
      { file: "src/app/connect/page.tsx", source: 'import { ConnectClient } from "./connect-client";' },
    ];
    expect(findUnreachable([SIBLING_SPEC], () => true, sources)).toEqual([]);
  });

  it("陰性: ファイル名が違えば到達と認めない", () => {
    const sources = [
      { file: "src/app/connect/connect-client.tsx", source: 'fetch("/api/csv/analyze")' },
      { file: "src/app/connect/page.tsx", source: 'import { Other } from "./other-client";' },
    ];
    expect(findUnreachable([SIBLING_SPEC], () => true, sources)).toEqual([
      { id: "csv-analyze", reason: "no-importer" },
    ]);
  });

  it("規約ファイル（page.tsx / middleware.ts）は import されなくても到達と認める", () => {
    const spec: EndpointSpec = {
      id: "auth-session",
      endpoint: "/api/auth/session",
      route: "src/app/api/auth/session/route.ts",
      contract: "A-1",
    };
    // login/page.tsx は誰からも import されない。Next が規約で直接読む
    const sources = [{ file: "src/app/login/page.tsx", source: 'fetch("/api/auth/session")' }];
    expect(findUnreachable([spec], () => true, sources)).toEqual([]);
  });

  it("陰性: 規約ファイルでない孤立したモジュールは到達と認めない", () => {
    const spec: EndpointSpec = {
      id: "auth-session",
      endpoint: "/api/auth/session",
      route: "src/app/api/auth/session/route.ts",
      contract: "A-1",
    };
    const sources = [{ file: "src/lib/auth/session-caller.ts", source: 'fetch("/api/auth/session")' }];
    expect(findUnreachable([spec], () => true, sources)).toEqual([
      { id: "auth-session", reason: "no-importer" },
    ]);
  });
});

describe("isConventionFile", () => {
  it("Next が規約で読むものを認める", () => {
    for (const f of [
      "src/app/login/page.tsx",
      "src/app/layout.tsx",
      "src/middleware.ts",
      "src/app/x/not-found.tsx",
    ]) {
      expect(isConventionFile(f), f).toBe(true);
    }
  });

  it("普通のモジュールは規約ファイルではない", () => {
    for (const f of ["src/lib/connections/disconnect.ts", "src/app/connect/connect-client.tsx"]) {
      expect(isConventionFile(f), f).toBe(false);
    }
  });
});

describe("実物の宣言", () => {
  it("**空にしない。** 0件で緑になるのは検査の空洞そのもの", () => {
    expect(ENDPOINT_SPECS.length).toBeGreaterThan(0);
  });

  it("id が重複していない", () => {
    const ids = ENDPOINT_SPECS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("宣言した route が src/app/api 配下を指している", () => {
    for (const s of ENDPOINT_SPECS) {
      expect(s.route.startsWith("src/app/api/"), s.id).toBe(true);
      expect(s.endpoint.startsWith("/api/"), s.id).toBe(true);
    }
  });
});
