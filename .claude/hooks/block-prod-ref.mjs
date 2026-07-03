import { readFileSync } from "node:fs";

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
