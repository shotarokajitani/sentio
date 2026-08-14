# hooks のカバレッジと残存制約

`.claude/settings.json` の PreToolUse フック3本（`block-env-read` / `block-prod-ref` /
`check-secrets-patterns`）が**どこまで守れて、どこから守れないか**を明示する。
黙って残った穴は「守られている」と誤読されるため、ここに顕在化させる。

## 現在の掛かり方

- matcher は3本とも `"*"`（全ツール）。ツール名を列挙する方式は、
  新ツール・間接ツール（Monitor 等）・サブエージェント経由の呼び出しを取りこぼす
- 判定はツール名ではなく**入力フィールドの形**で行う（`.claude/hooks/_input.mjs`）
  - パス系: `file_path` / `notebook_path` / `path` / `filePath` / `file` / `output_file`
  - コマンド系: `command` / `script` / `code` / `cmd` / `run` / `shell` / `bash`
- 入力がJSONとして読めなかった場合はペイロード全体を走査する（取りこぼすより過剰に見る）
- 例外時は必ず deny（fail-closed）

## 守れない範囲（設計上の限界。これは仕様であって不具合ではない）

1. **PreToolUse はツールの「入力」しか見えない。**
   `bash ./setup.sh` の入力に `.env` も本番Refも現れなければ、そのスクリプトが
   内部で `.env` を読もうと本番Refを使おうと検出できない。
   間接実行（スクリプト・Makefile・npm script）は原理的に射程外
2. **hook定義の反映タイミングはバージョン依存。**
   2026-08-15 の実測では、`.claude/settings.json` の matcher 変更は**同一セッション内で即時反映**された
   （`check-secrets-patterns` を `Write|Edit` → `*` に変えた直後、Bash 呼び出しで deny が発火）。
   ただしこれはハーネス実装に依存する挙動であり保証ではない。
   **matcher を変更したら、変更が効いていることを毎回実測で確かめること。**
   効いていない場合はセッション再起動（または `/hooks` でのレビュー）が必要
3. **hooks はローカル専用。** CI・他クローン・他マシン・Web/クラウド実行では動かない。
   リポジトリ側の担保は CI の `gitleaks` と `pnpm run check:allowlist` であり、
   hooks はそれを前倒しするだけの二重化に過ぎない
4. **`block-prod-ref` は「言及」を止めない。**
   本番Ref はコマンド系・パス系フィールドでのみ検査する。
   `CLAUDE.md` や `.claude/rules/security.md` は規則として本番Refを本文に含むため、
   ペイロード全体を走査すると**それらの文書を編集する行為自体が deny** され、
   設定を直すための Edit もブロックされて自力復旧できなくなる（同型の事故が2026-08-12に発生）。
   止めるべきは操作であって記述ではない
5. **コマンド文字列内の「言及」は完全には切り分けられない。**
   ヒアドキュメント本体（`<<'EOF' … EOF`）と `#` コメントは記述として除外するが、
   `echo "…​.env…"` のようにクォート文字列で言及した場合は deny される。
   コマンド文字列とファイル内容を完全に区別する構文解析はしていない
   （`cat ".env"` を逃さないことを優先した）。
   文書に書きたい場合は Write / Edit を使う（内容フィールドは走査対象外）
6. **`block-env-read` は `.env` を「作る」操作も止める。**
   `cp .env.example .env` のようにトークンとして `.env` が現れる操作は deny される。
   初期セットアップは人間の手で行う前提

## 変更時の作法

フック3本または matcher を変更したら、**陽性・陰性の両コントロールを実物出力付きで残す**こと。

- 陽性: 通常のファイル書き込みが pass すること
- 陰性: 本番Ref を含むコマンド、`.env` 読み取り、秘密パターンがそれぞれ deny されること
  `node .claude/hooks/selftest.mjs` が上記を14ケースで自動検証する。
  スクリプト論理はこれで担保できるが、**matcher が実際に掛かっているかは別問題**なので、
  「旧matcherでは対象外だったツール」で1回実操作して deny を確認すること
  （例: `check-secrets-patterns` を `Write|Edit` → `*` にしたなら、Bash で発火するかを見る）。
