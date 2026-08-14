// .env の読み取りを止める（.env.example のみ許可）。matcher "*" で全ツールに掛かる。
import {
  readHookInput,
  collectStrings,
  tokenizeCommand,
  deny,
  failClosed,
  COMMAND_KEYS,
  PATH_KEYS,
} from "./_input.mjs";

// `.env` / `.env.local` は該当し、`.envrc` は該当しない
const isEnvPath = (s) => /\.env($|\.)/.test(s) && !s.includes(".env.example");

try {
  const input = readHookInput();

  // ① パス系フィールド（Read / Edit / Write / NotebookEdit ほか）
  if (collectStrings(input, PATH_KEYS).some(isEnvPath)) {
    deny(".envの読み取りは禁止（.env.exampleのみ許可）");
  }

  // ② コマンド系フィールド（Bash / Monitor ほか）。`cat .env` の類を
  //    トークンに割ってからパスとして評価する
  const viaCommand = collectStrings(input, COMMAND_KEYS).flatMap(tokenizeCommand).some(isEnvPath);
  if (viaCommand) {
    deny(".envをコマンド経由で読む操作は禁止（.env.exampleのみ許可）");
  }

  process.exit(0);
} catch (e) {
  failClosed("block-env-read", e);
}
