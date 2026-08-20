# グローバル Prettier フックの修正（Q8 案2・**人間作業**）

実行者: **梶谷さん**。CC も検収側（Cowork）も `~/.claude/settings.json` への書き込みが
自動モードの分類器に拒否されるため、手作業が要る。所要 5分。

**これは Sentio の設定ではない。** `~/.claude/settings.json` はユーザーのグローバル設定であり、
**全プロジェクトに影響する。** Sentio 以外のリポジトリの lockfile・生成物・
インデント依存の Markdown も、今この経路で書き換わっている。

## 現状（2026-08-20 実測。`settings.json:44`）

```json
{
  "PostToolUse": [
    {
      "matcher": "Write|Edit",
      "hooks": [
        { "type": "command", "command": "npx prettier --write . 2>/dev/null; true" }
      ]
    }
  ]
}
```

問題は3つ。

1. **`--write .` がリポジトリ全体を対象にする。** 編集したファイルだけではない。
   `pnpm-lock.yaml`（5061行）/ `src/i18n/ja.ts` / `docs/checklists/env-diff.md` が
   無関係に書き換わっていたのは、すべてこの1本が原因
2. **`2>/dev/null; true` で必ず成功扱いになる。** 失敗しても誰も気づけない
3. **`env-diff.md` の破壊が非冪等。** 1回あたりインデントが +4 押し下がり
   （元6 → 14 → 34 を実測）、ずれが3以上になると終了フェンスが閉じず、
   表がコードブロックに飲まれる

## 仕様の確認（推測ではなく公式ドキュメント）

`https://code.claude.com/docs/en/hooks` を読んで確定させた。

| 事項 | 実際 |
| --- | --- |
| `type: "command"` フックの入力 | **stdin に JSON**。`tool_input.file_path` に編集先が入る |
| `$CLAUDE_FILE_PATHS` 環境変数 | **存在しない。** ドキュメント全体の `CLAUDE_*` 一覧に無い |
| `${tool_input.file_path}` 置換 | `type: "mcp_tool"` の `input` 専用。**command フックでは使えない** |
| exit 0 の stderr | **デバッグログにしか出ない。** Claude には見えない |
| exit 2 の stderr | **PostToolUse では Claude に表示される。ツールは既に実行済みなのでブロックにはならない** |

したがって「失敗を握りつぶさない」を満たすには **exit 2** が要る。
`; true` で 0 に丸めると、`2>/dev/null` を外しても結局見えないままになる。

## 手順

### 1. バックアップ

```powershell
Copy-Item "$env:USERPROFILE\.claude\settings.json" "$env:USERPROFILE\.claude\settings.json.bak-20260820"
```

### 2. スクリプトを置く

`C:\Users\shota\.claude\hooks\format-edited.mjs` を新規作成し、以下を貼る。
（`hooks` ディレクトリが無ければ作る）

JSON に長いコマンドを直書きするとエスケープで壊れやすいので、外出しにする。

```js
// PostToolUse (Write|Edit): 編集された 1 ファイルだけを Prettier に通す。
//
// 旧実装は `npx prettier --write .` で、編集と無関係なファイルまでリポジトリ全体を
// 書き換えていた（2026-08-20: pnpm-lock.yaml 5061行 / env-diff.md の表の破壊）。
//
// 入力は stdin の JSON。`tool_input.file_path` に編集先が入る（公式ドキュメント準拠）。
// $CLAUDE_FILE_PATHS のような環境変数は存在しない。
//
// 失敗は握りつぶさない。PostToolUse では exit 2 の stderr が Claude に表示される。
// ツールは既に実行済みなので、これは編集をブロックしない。
import { spawnSync } from "node:child_process";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let filePath;
  try {
    filePath = JSON.parse(raw)?.tool_input?.file_path;
  } catch (e) {
    console.error(`format-edited: stdin を JSON として読めない: ${e.message}`);
    process.exit(2);
  }

  // Write/Edit 以外が混ざった場合や、パスが無い場合は何もしない
  if (!filePath) process.exit(0);

  const r = spawnSync("npx", ["prettier", "--write", filePath], {
    stdio: ["ignore", "ignore", "pipe"],
    shell: process.platform === "win32",
    encoding: "utf8",
  });

  if (r.error) {
    console.error(`format-edited: npx を起動できない: ${r.error.message}`);
    process.exit(2);
  }
  if (r.status !== 0) {
    console.error(`format-edited: prettier が失敗した (${filePath})`);
    if (r.stderr) console.error(r.stderr.trim());
    process.exit(2);
  }
  process.exit(0);
});
```

### 3. `settings.json:44` のフックを差し替える

`command` の値だけを次に変える。`matcher` は `Write|Edit` のままでよい。

```json
{
  "PostToolUse": [
    {
      "matcher": "Write|Edit",
      "hooks": [
        {
          "type": "command",
          "command": "node \"%USERPROFILE%\\.claude\\hooks\\format-edited.mjs\"",
          "statusMessage": "編集したファイルを整形中"
        }
      ]
    }
  ]
}
```

> `%USERPROFILE%` が展開されない場合は、絶対パス
> `node \"C:\\Users\\shota\\.claude\\hooks\\format-edited.mjs\"` に置き換える。
> **JSON なのでバックスラッシュは 2 個**であることに注意。

### 4. JSON として妥当か確かめる

```powershell
node -e "JSON.parse(require('fs').readFileSync(process.env.USERPROFILE + '/.claude/settings.json','utf8')); console.log('JSON OK')"
```

`JSON OK` が出ること。出なければ手順1のバックアップから戻す。

### 5. Claude Code を再起動する

フック定義の反映タイミングはバージョン依存
（`.claude/rules/hooks-coverage.md` §2 に同じ注意がある）。

## 検証（CC にやらせてよい。実測を報告させること）

1. スクラッチファイル（例 `tmp/fmt-probe.ts`）に**わざと崩れた整形**で Write する
2. **そのファイルだけ**が整形されること
3. `git status --porcelain` に **`docs/checklists/env-diff.md` と `pnpm-lock.yaml` が出ないこと**
4. `docs/checklists/env-diff.md` を Write で1回触り、**表が壊れないこと**
   （これが本丸。壊れたら差し戻し）
5. 壊れたファイル（Prettier がパースできないもの）を Write して、
   **stderr が見えること**（旧実装では見えなかった）
6. スクラッチファイルを消す

## 案1 との関係

`.prettierignore` への `docs/checklists/env-diff.md` 追加（コミット `01d74e5`）は
**この修正が入っても残す。** Bash 経由で `prettier --write .` を回した場合は
フックを通らないため、保険として要る。

## 戻し方

```powershell
Copy-Item "$env:USERPROFILE\.claude\settings.json.bak-20260820" "$env:USERPROFILE\.claude\settings.json" -Force
```

`PostToolUse` フックは編集をブロックしないので、フックが壊れても
`settings.json` を編集して自力復旧できる。ロックアウトの経路は無い。
