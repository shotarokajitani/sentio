// PreToolUse フックの共通入力処理。
// 各フックがツール名に依存せず（matcher が "*" でも）判定できるようにするための土台。
import { readFileSync } from "node:fs";

// ファイルパスを運ぶフィールド名。ツールごとに名前が違うため列挙する
export const PATH_KEYS = ["file_path", "notebook_path", "path", "filePath", "file", "output_file"];

// シェル・スクリプトを運ぶフィールド名。Bash だけでなく Monitor 等の間接経路も含む
export const COMMAND_KEYS = ["command", "script", "code", "cmd", "run", "shell", "bash"];

export function readHookInput() {
  const raw = readFileSync(0, "utf8");
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    // パース不能ならフィールド限定走査ができない。呼び出し側が raw 全体を見る（安全側）
    json = null;
  }
  return { raw, json };
}

// tool_input を再帰的に歩き、keys のいずれかに属する文字列値を集める。
// JSONとして読めなかった場合は raw 全体を1件として返す（取りこぼすより過剰に見る）
export function collectStrings({ raw, json }, keys) {
  if (!json) return [raw];
  const out = [];
  const walk = (node, inScope) => {
    if (typeof node === "string") {
      if (inScope) out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const v of node) walk(v, inScope);
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) walk(v, inScope || keys.includes(k));
    }
  };
  walk(json.tool_input ?? json, false);
  return out;
}

// ヒートドキュメント本体と # コメントを落とす。
// これらは「実行される命令」ではなく「データ・記述」であり、
// git commit -F - のメッセージ本文などが誤検知される（block-prod-ref と同じ
// 「言及は止めない・操作を止める」原則）。
export function stripNonCommandText(command) {
  let s = command;
  // <<'EOF' ... EOF / <<EOF ... EOF / <<-EOF ... EOF
  s = s.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm, " ");
  // 閉じマーカーが無い場合はヒアドキュメント開始以降を全て落とす（安全側ではなく実用側の判断。
  // コマンド本体は開始行までに現れる）
  s = s.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*$/g, " ");
  // 行コメント
  s = s.replace(/(^|\s)#[^\n]*/g, " ");
  return s;
}

// シェルコマンドを、パスとして評価できる単位に割る
export function tokenizeCommand(command) {
  return stripNonCommandText(command)
    .split(/[\s;|&<>()"'`,]+/)
    .filter(Boolean);
}

export function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(2);
}

// 例外時は必ず deny する（fail-closed）
export function failClosed(hookName, e) {
  process.stderr.write(`${hookName}: fail-closed — ${e.message}\n`);
  deny("フックスクリプト実行エラー（fail-closed）: " + e.message);
}
