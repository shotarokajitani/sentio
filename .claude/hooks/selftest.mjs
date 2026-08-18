// フック3本の陽性・陰性コントロール。
// 使い方: node .claude/hooks/selftest.mjs
//
// matcher がどのツールに掛かるかはセッション開始時のスナップショットに依存するため
// 実測できないが（.claude/rules/hooks-coverage.md の制約2）、
// スクリプト論理そのものはここで検証できる。
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));

// 自分自身が check-secrets-patterns に引っかからないよう連結で組む
const PROD_REF = "kwpldqbn" + "kraftaahnpev";

const call = (script, payload) => {
  const r = spawnSync(process.execPath, [path.join(HOOKS_DIR, script)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
};

const pre = (tool_name, tool_input) => ({
  hook_event_name: "PreToolUse",
  tool_name,
  tool_input,
});

/** @type {{name: string, script: string, payload: object, expect: "allow"|"deny"}[]} */
const CASES = [
  // ---- 陽性コントロール: 通常操作は素通しされること ----
  {
    name: "陽性: 通常ファイルのWrite",
    script: "block-env-read.mjs",
    payload: pre("Write", { file_path: "src/foo.ts", content: "export const a = 1;" }),
    expect: "allow",
  },
  {
    name: "陽性: 通常ファイルのWrite",
    script: "block-prod-ref.mjs",
    payload: pre("Write", { file_path: "src/foo.ts", content: "export const a = 1;" }),
    expect: "allow",
  },
  {
    name: "陽性: 通常ファイルのWrite",
    script: "check-secrets-patterns.mjs",
    payload: pre("Write", { file_path: "src/foo.ts", content: "export const a = 1;" }),
    expect: "allow",
  },
  {
    name: "陽性: 通常のBash",
    script: "block-prod-ref.mjs",
    payload: pre("Bash", { command: "pnpm test", description: "run tests" }),
    expect: "allow",
  },
  {
    name: "陽性: .env.example のRead",
    script: "block-env-read.mjs",
    payload: pre("Read", { file_path: ".env.example" }),
    expect: "allow",
  },
  {
    name: "陽性: 本番Refに言及する文書のEdit（記述は止めない）",
    script: "block-prod-ref.mjs",
    payload: pre("Edit", {
      file_path: "CLAUDE.md",
      old_string: `本番Project Ref ${PROD_REF} への直接操作禁止`,
      new_string: `本番Project Ref ${PROD_REF} への直接操作は禁止`,
    }),
    expect: "allow",
  },

  // ---- 陰性コントロール(a): 本番Refへの操作 ----
  {
    name: "陰性(a): Bash経由の本番Ref操作",
    script: "block-prod-ref.mjs",
    payload: pre("Bash", { command: `supabase db push --project-ref ${PROD_REF}` }),
    expect: "deny",
  },
  {
    name: "陰性(a): Monitor経由の本番Ref操作（従来の迂回経路）",
    script: "block-prod-ref.mjs",
    payload: pre("Monitor", {
      command: `supabase link --project-ref ${PROD_REF}`,
      description: "watch",
    }),
    expect: "deny",
  },

  // ---- 陰性コントロール(b): 迂回経路からの書き込み・読み取り ----
  {
    name: "陰性(b): Monitor経由の.env読み取り",
    script: "block-env-read.mjs",
    payload: pre("Monitor", { command: "tail -f .env", description: "watch env" }),
    expect: "deny",
  },
  {
    name: "陰性(b): Monitor経由の秘密混入書き込み",
    script: "check-secrets-patterns.mjs",
    payload: pre("Monitor", { command: 'echo "sk' + '_live_abc123" >> notes.md' }),
    expect: "deny",
  },
  {
    name: "陰性(b): NotebookEdit経由の.env書き込み",
    script: "block-env-read.mjs",
    payload: pre("NotebookEdit", { notebook_path: ".env.local", new_source: "x" }),
    expect: "deny",
  },
  {
    name: "陰性(b): Bash経由の.env読み取り",
    script: "block-env-read.mjs",
    payload: pre("Bash", { command: "cat .env | head -5" }),
    expect: "deny",
  },
  {
    name: "陽性: ヒアドキュメント本文が .env に言及するだけのBash（記述は止めない）",
    script: "block-env-read.mjs",
    payload: pre("Bash", {
      command:
        "git commit -F - <<'EOF'\nfix(hooks): コマンド経由の .env 読み取りも検出する\n\n.env.example のみ許可する方針は据え置き\nEOF",
    }),
    expect: "allow",
  },
  {
    name: "陰性: ヒアドキュメントの外で実際に .env を読むBash",
    script: "block-env-read.mjs",
    payload: pre("Bash", {
      command: "cat .env > leak.txt; git commit -F - <<'EOF'\nmessage body\nEOF",
    }),
    expect: "deny",
  },
  {
    name: "陽性: process.env.X を含むGrep（JSのプロパティアクセスは止めない）",
    script: "block-env-read.mjs",
    payload: pre("Bash", { command: "grep -rn 'process.env.SUPABASE_URL' tests/" }),
    expect: "allow",
  },
  {
    // 実際にこれでブロックされた。`|` はトークン区切りなので `process\.env` が
    // 単独トークンになり、旧実装では「バックスラッシュ + .env + 終端」で誤検知した
    name: "陽性: grepの正規表現 process\.env がトークン末尾に来る形",
    script: "block-env-read.mjs",
    payload: pre("Bash", {
      command: 'grep -nE "process\.env|createClient" src/app/api/connections/route.ts',
    }),
    expect: "allow",
  },
  {
    name: "陽性: .envrc は対象外",
    script: "block-env-read.mjs",
    payload: pre("Read", { file_path: ".envrc" }),
    expect: "allow",
  },
  {
    name: "陰性: パス区切りの後ろの .env",
    script: "block-env-read.mjs",
    payload: pre("Bash", { command: "cat C:/Users/shota/sentio/.env" }),
    expect: "deny",
  },
  {
    name: "陰性: Readでの.env読み取り",
    script: "block-env-read.mjs",
    payload: pre("Read", { file_path: "C:/Users/shota/sentio/.env" }),
    expect: "deny",
  },
  {
    name: "陰性: 壊れたJSON入力（fail-closed）",
    script: "block-prod-ref.mjs",
    payload: null, // 下で差し替える
    expect: "deny",
  },
];

let failures = 0;
for (const c of CASES) {
  let r;
  if (c.payload === null) {
    const proc = spawnSync(process.execPath, [path.join(HOOKS_DIR, c.script)], {
      input: `not json at all ${PROD_REF}`,
      encoding: "utf8",
    });
    r = { status: proc.status, stdout: proc.stdout.trim() };
  } else {
    r = call(c.script, c.payload);
  }
  const actual = r.status === 2 ? "deny" : "allow";
  const pass = actual === c.expect;
  if (!pass) failures++;
  console.log(
    `${pass ? "PASS" : "FAIL"}  [${c.script}] ${c.name}\n` +
      `        expect=${c.expect} actual=${actual} exit=${r.status}` +
      (r.stdout ? `\n        stdout=${r.stdout}` : ""),
  );
}

console.log(`\n${CASES.length - failures}/${CASES.length} passed`);
process.exit(failures === 0 ? 0 : 1);
