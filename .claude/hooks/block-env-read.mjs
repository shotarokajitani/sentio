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

// 正規表現のエスケープ `\.` を先に畳んでから判定する。
// grep のパターンに現れる `process\.env` は、素で見ると「バックスラッシュ + .env」で
// パス区切りの直後と区別できず誤検知していた（実際にブロックされた）。
const unescapeRegex = (s) => s.replace(/\\./g, ".");

// `.env` / `.env.local` / `path/to/.env` は該当する。
// 該当しないもの:
//   - `.envrc`        … 別物のファイル
//   - `process.env.X` … JSのプロパティアクセス（パス境界を要求して除外）
//   - `process\.env`  … grepの正規表現（上のエスケープ畳み込みで除外）
//   - `config.env`    … .gitignore が守る対象は `.env` / `.env.*` のみ
//
// 残る制約: バックスラッシュ区切りのWindowsパス（C:\dir\.env）は、
// エスケープ畳み込みで `.env` 直前の区切りが失われるため検出できない。
// Git Bash ではバックスラッシュはエスケープ扱いでパスとして機能しないため、
// 実運用での取りこぼしは想定していない。スラッシュ区切りは従来どおり検出する。
const isEnvPath = (raw) => {
  const s = unescapeRegex(raw);
  return /(^|\/)\.env($|\.)/.test(s) && !s.includes(".env.example");
};

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
