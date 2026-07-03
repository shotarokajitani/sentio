import { readFileSync } from "node:fs";

// Build patterns via concatenation to avoid self-triggering the hook
const patterns = [
  "sk" + "_live",
  "wh" + "sec_",
  "xo" + "xb-",
  "GO" + "CSPX-",
  "re" + "_[A-Za-z0-9]{16}",
];
const regex = new RegExp(patterns.join("|"));

const input = readFileSync(0, "utf8");
if (regex.test(input)) {
  const result = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "秘密の実値らしき文字列を検出。値はVault/Secretsへ、文書にはポインタのみ",
    },
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(2);
}
process.exit(0);
