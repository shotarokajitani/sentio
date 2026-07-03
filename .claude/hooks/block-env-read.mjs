import { readFileSync } from "node:fs";

const input = readFileSync(0, "utf8");
const match = input.match(/"file_path"\s*:\s*"([^"]*)"/);
if (match) {
  const filePath = match[1];
  if (/\.env($|\.)/.test(filePath) && !filePath.includes(".env.example")) {
    const result = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          ".envの読み取りは禁止（.env.exampleのみ許可）",
      },
    };
    process.stdout.write(JSON.stringify(result));
    process.exit(2);
  }
}
process.exit(0);
