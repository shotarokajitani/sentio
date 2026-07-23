import { readFileSync } from "node:fs";

try {
  const input = readFileSync(0, "utf8");
  if (input.includes("kwpldqbnkraftaahnpev")) {
    const result = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "本番Project Refへの直接操作は禁止。本番反映はCI/CDのみ",
      },
    };
    process.stdout.write(JSON.stringify(result));
    process.exit(2);
  }
  process.exit(0);
} catch (e) {
  process.stderr.write(`block-prod-ref: fail-closed — ${e.message}\n`);
  const result = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "フックスクリプト実行エラー（fail-closed）: " + e.message,
    },
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(2);
}
