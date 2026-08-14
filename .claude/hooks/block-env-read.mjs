import { readFileSync } from "node:fs";

try {
  const input = readFileSync(0, "utf8");
  const match = input.match(/"file_path"\s*:\s*"([^"]*)"/);
  if (match) {
    const filePath = match[1];
    if (/\.env($|\.)/.test(filePath) && !filePath.includes(".env.example")) {
      const result = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: ".envの読み取りは禁止（.env.exampleのみ許可）",
        },
      };
      process.stdout.write(JSON.stringify(result));
      process.exit(2);
    }
  }
  process.exit(0);
} catch (e) {
  process.stderr.write(`block-env-read: fail-closed — ${e.message}\n`);
  const result = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "フックスクリプト実行エラー（fail-closed）: " + e.message,
    },
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(2);
}
