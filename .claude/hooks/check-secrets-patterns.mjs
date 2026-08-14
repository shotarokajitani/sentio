// 秘密の実値らしき文字列の混入を止める。matcher "*" で全ツールに掛かる。
// 書き込み内容だけでなくコマンド・検索語も対象にするため、ペイロード全体を走査する。
import { readHookInput, deny, failClosed } from "./_input.mjs";

try {
  // Build patterns via concatenation to avoid self-triggering the hook
  const patterns = [
    "sk" + "_live",
    "wh" + "sec_",
    "xo" + "xb-",
    "GO" + "CSPX-",
    "re" + "_[A-Za-z0-9]{16}",
  ];
  const regex = new RegExp(patterns.join("|"));

  const { raw } = readHookInput();
  if (regex.test(raw)) {
    deny("秘密の実値らしき文字列を検出。値はVault/Secretsへ、文書にはポインタのみ");
  }

  process.exit(0);
} catch (e) {
  failClosed("check-secrets-patterns", e);
}
