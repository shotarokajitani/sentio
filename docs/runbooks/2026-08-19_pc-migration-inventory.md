# PC買い替え前の棚卸し（2026-08-19 実測）

旧PC（Windows 11 Home 10.0.26200）でしか取得できない情報を、新PC（2026-08-20 以降）で
同じ構成を再現するために固定する。**全項目とも実測値**であり、記憶や推定は含まない。

秘密の値は一切書かない。本書に載るのは**パスと有無だけ**である。

---

## 1. 現行ツールのバージョン（実測）

| ツール       | バージョン                      | 実行ファイルの場所                    | 導入経路               |
| ------------ | ------------------------------- | ------------------------------------- | ---------------------- |
| Node.js      | `v24.13.1`                      | `C:\Program Files\nodejs\node`        | 公式インストーラ       |
| npm          | `11.8.0`                        | `C:\Program Files\nodejs\npm`         | Node同梱               |
| pnpm         | `11.21.0`                       | `%APPDATA%\npm\pnpm`                  | npm グローバル         |
| Git          | `2.53.0.windows.2`              | `/mingw64/bin/git`（Git for Windows） | 公式インストーラ       |
| GitHub CLI   | `2.97.0 (2026-07-31)`           | `C:\Program Files\GitHub CLI\gh`      | 公式インストーラ       |
| Supabase CLI | `2.110.0`（global／**要注意**） | `C:\Users\shota\scoop\shims\supabase` | scoop（main bucket）   |
| Claude Code  | `2.1.235`                       | `%APPDATA%\npm\claude`                | npm グローバル         |
| Docker       | `29.6.1, build 8900f1d`         | `C:\Program Files\Docker\...\docker`  | Docker Desktop         |
| Deno         | `2.1.4`（**CIと同値に固定**）   | `%USERPROFILE%\.deno\bin\deno.exe`    | GitHub Releases の zip |

> Docker は一覧指定に無いが、`supabase start`（ローカルスタック）が依存するため併記した。

> **Deno は `pnpm run check:edge-types`（Edge Function の型検査）に必要。**
> `tsconfig.json` は各 Function の `index.ts` を除外しているため、
> `pnpm typecheck` はそこを1行も見ていない。型検査の実体は `deno check` だけである
> （2026-08-19: typecheck / lint / unit が全部緑の状態で `deno check` が28件で落ちた）。
> **バージョンは CI の `denoland/setup-deno`（`v2.1.4`）と揃える。**
> ずれていると `scripts/check-edge-types.ts` が警告を出す。
> 近似での代替（tsc に寄せた設定など）は**用意しない**。近似が緑でも `deno check` が
> 緑とは限らず、それを緑と読むこと自体が新しい空洞になる。

### Supabase CLI 2.113.0 固定 — 現状は「2系統」に分かれている

`2.113.0` 固定は必須要件だが、旧PCの実測では**globalとプロジェクトローカルでバージョンが違う**。

| 系統                 | 実測バージョン | 参照元                                                   |
| -------------------- | -------------- | -------------------------------------------------------- |
| global（scoop shim） | `2.110.0`      | `supabase --version`                                     |
| プロジェクトローカル | `2.113.0`      | `npx --no-install supabase --version`                    |
| lockfile 固定        | `2.113.0`      | `pnpm-lock.yaml:2332` / `:4863` — `supabase@2.113.0`     |
| CI（`ci.yml`）       | `2.113.0`      | `.github/workflows/ci.yml:45`                            |
| CD（`deploy.yml`）   | `2.113.0`      | `.github/workflows/deploy.yml:43` / `:79`（2ジョブとも） |

**固定が効いているのは lockfile と CI/CD 側**であり、`2.113.0` は満たされている。
ズレているのは scoop で入れた global shim だけ。

新PCでの方針（**事故を防ぐための明示**）:

- **素の `supabase ...` を叩かない。** 必ず `pnpm exec supabase ...` を使う。
  素で叩くと 2.110.0 側が動き、CI と違う挙動になる
- scoop で入れ直すなら `2.113.0` を明示すること。バージョン未指定の `scoop install supabase` は
  latest を拾い、**latest は破壊的変更で事故実績がある**
  （`docs/Cowork_引き継ぎ指示_Sentio_20260816.md:53` — dependabot #5 は固定方針と衝突するため close 済み）
- いちばん安全なのは **global に入れないこと**。`pnpm install` すれば 2.113.0 が入る

---

## 2. 移送が必要な git 管理外ファイル（パスと有無のみ）

**中身は本書に一切書かない。** 以下は USB 移送の照合用チェックリストである。
`.env.example` は git 追跡済みなので clone すれば復元され、移送は不要。

親フォルダ `C:\Users\shota\` 配下の Diseno 系プロジェクトを全走査した
（`node_modules` / `.git` は除外、深さ3まで）。

### 要移送（git 管理外）

| #   | プロジェクト | パス（`C:\Users\shota\` 起点）         | 状態                      |
| --- | ------------ | -------------------------------------- | ------------------------- |
| 1   | sentio       | `sentio\.env`                          | 未追跡・要移送            |
| 2   | sentio       | `sentio\supabase\functions\.env.local` | 未追跡・要移送            |
| 3   | lauda-v2     | `lauda-v2\.env`                        | 未追跡・要移送            |
| 4   | lauda-v2     | `lauda-v2\supabase\functions\.env`     | 未追跡・要移送            |
| 5   | lauda-v2     | `lauda-v2\supabase\functions\.env.txt` | 未追跡・要移送            |
| 6   | motus        | `motus\.env.local`                     | 未追跡・要移送            |
| 7   | verso        | `verso\.env.local`                     | 未追跡・要移送            |
| 8   | merutal      | `merutal\.env`                         | 非gitディレクトリ・要移送 |

> #5 `lauda-v2\supabase\functions\.env.txt` は拡張子が `.txt` である。
> `.gitignore` の `.env*` に引っかかるので追跡はされていないが、
> **名前が紛れやすいので移送時に見落としやすい**。要注意。

### 移送不要（git 追跡済み ＝ clone で復元される）

- `sentio\.env.example`
- `lauda-v2\.env.example`
- `motus\.env.example`

### 該当ファイルなし

`diseno_bot`（非git） / `lauda` / `motus_legacy_shoptok` / `ratio` / `recto` /
`semiconductor-monitor` — 環境ファイルは0件。

### 追加で要移送（プロジェクト外だが秘密を持つ）

| パス                                            | 内容                                |
| ----------------------------------------------- | ----------------------------------- |
| `C:\Users\shota\.claude\channels\telegram\.env` | Telegram bot トークン（66バイト）   |
| `C:\Users\shota\.claude\.credentials.json`      | Claude Code の認証情報（509バイト） |

> 後者は新PCで `claude` に再ログインすれば再生成されるため、**移送より再ログインが安全**。

---

## 3. 未push作業の確認（sentio・実測）

### `git status`

```
On branch main
Your branch is up to date with 'origin/main'.

Untracked files:
	.playwright-mcp/

nothing added to commit but untracked files present
```

### `git log origin/main..HEAD`

```
（出力0行 / exit=0）
```

**main に未pushコミットは無い。**

### 全ローカルブランチの ahead 数

20本すべてで `origin/<branch>..<branch>` の commit 数が **0**。
未pushコミットを持つブランチは1本も無い。

### 残る2件（移送しないと消えるもの）

| 対象               | 内容                                                                                                                                                              | 判断           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `.playwright-mcp/` | 未追跡ディレクトリ。Playwright MCP の作業生成物                                                                                                                   | 破棄でよい     |
| **stash 1件**      | `stash@{0}: On feat/slice-01-walking-skeleton: prettier reformat (printWidth 100) - unrelated to deploy fix`<br>108ファイル / +1836 −2053。整形のみで機能差分なし | **検収者判断** |

> **stash はリモートに存在しない。**`git push` では移送されず、PC買い替えで確実に消える。
> 内容は7月の `feat/slice-01-walking-skeleton` 上の prettier 整形で、
> 当該ブランチはとうに main へ入っている。復活させる理由は薄いが、
> 捨てる判断は機械側では行わない。**破棄してよいかを買い替え前に決めること。**
> 残すなら `git stash show -p stash@{0} > <退避先>.patch` でファイル化して移送する。

---

## 4. `C:\Users\shota\.claude` 配下の退避対象

> **以前ここの `settings.json` を DB バックアップと取り違えた事故がある。**
> そのため各行に「何のファイルか」を必ず添える。名前だけで判断しないこと。

### 必ず移送する（人間が育てた設定・再生成できない）

| パス                                     | 何のファイルか                                                                                                                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CLAUDE.md`                              | **全プロジェクト共通のグローバル指示**（5,554バイト）。日本語回答・TDD・自己検証などの運用規約。DBとは無関係                                                                                                                                                 |
| `settings.json`                          | **Claude Code のグローバル設定**（6,526バイト）。DBバックアップではない。キーは `permissions` / `hooks` / `enabledPlugins` / `extraKnownMarketplaces` / `autoUpdatesChannel` / `tui` / `autoMode`。`hooks.PostToolUse` に `npx prettier --write .` を1本定義 |
| `settings.local.json`                    | **このマシン固有の権限許可リスト**（14,025バイト）。`permissions.allow` が **212件**。これが無いと新PCで許可プロンプトが大量に出る                                                                                                                           |
| `channels\telegram\access.json`          | Telegram チャネルの許可リスト（100バイト）。誰が bot に話しかけてよいか                                                                                                                                                                                      |
| `channels\telegram\.env`                 | Telegram bot トークン（**秘密**・66バイト）。中身は本書に書かない                                                                                                                                                                                            |
| `projects\C--Users-shota-sentio\memory\` | sentio の永続メモリ3ファイル（`MEMORY.md` / `phase3-migration-repair-todo.md` / `stop-hook-uv-spawn-failure.md`）                                                                                                                                            |
| `plans\`                                 | 過去の計画ファイル 6件・88KB                                                                                                                                                                                                                                 |

### 移送しない（再生成される／巨大）

| パス                                                                                                               | 何のファイルか                                                      | 理由                                                           |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------- |
| `plugins\`                                                                                                         | インストール済みプラグイン実体（19,825ファイル・**569MB**）         | `enabledPlugins` から再インストールできる                      |
| `projects\`（memory以外）                                                                                          | 会話ログ・履歴（522ファイル・**131MB**）                            | 記録用。必要なら選択的に                                       |
| `file-history\`                                                                                                    | ファイル編集履歴（1,759ファイル・12MB）                             | 作業キャッシュ                                                 |
| `history.jsonl`                                                                                                    | コマンド入力履歴（989KB）                                           | 任意                                                           |
| `cache\` `paste-cache\` `shell-snapshots\` `session-env\` `sessions\` `tasks\` `telemetry\` `downloads\` `chrome\` | 各種キャッシュ・一時状態                                            | 再生成される                                                   |
| `backups\`                                                                                                         | `.claude.json.backup.*` 5件 ＋ `.claude.corrupted.*` 1件（計264KB） | **Claude Code 自身の設定バックアップ。DBバックアップではない** |
| `.last-cleanup` `.last-update-result.json`                                                                         | Claude Code の内部状態                                              | 再生成される                                                   |

### 注意 — 存在しないもの

- **`.claude\hooks\` はグローバルには存在しない。** hooks の実体は
  `C:\Users\shota\sentio\.claude\hooks\`（**git 管理下**）にあり、clone で復元される。
  グローバル側にあるのは `settings.json` 内の `PostToolUse` 定義1本だけ
- **`.claude\skills\` は空**（0ファイル）。スキルはすべて `plugins\` 由来で、
  再インストールで復元される
- `C:\Users\shota\.claude.json`（`.claude` **ディレクトリの外**・51,677バイト）は
  Claude Code のグローバル状態ファイル。`backups\` の中身はこれのバックアップ

---

## 5. 移行チェックリストの「移行後の推奨タスク」は**両方とも完了済み**

> **新PCで古い前提のまま実行すると事故になる。**
> プロジェクトナレッジ側の移行チェックリストに残っている「移行後の推奨タスク」2件は、
> 旧PCでの作業中に**すでに完了している**。新PCで再実行してはならない。

### (1) 旧スキーマ削除 ＝ `00021` 適用済み

| 確認項目         | 実測                                                                             |
| ---------------- | -------------------------------------------------------------------------------- |
| マイグレーション | `supabase/migrations/00021_drop_legacy_schema.sql` がリポジトリに存在            |
| 内容             | 旧スキーマ16テーブルの削除 ＋ 旧cronジョブ7件の解除（方針A・2026-08-17 決定）    |
| 本番適用         | PR #17 の `deploy.yml` 実行が **2026-08-18 success**（`deploy-migrations` 完走） |
| 現在地           | `00001〜00022 本番適用済み`（`docs/Cowork_引き継ぎ指示_Sentio_20260816.md:54`）  |
| 最新の再確認     | 2026-08-19 の deploy run #32208342847 で `Apply migrations` が success           |

**再実行は不要。** 削除対象テーブルはもう存在しないため、
古い手順書どおりに DROP を流しても意味が無いか、別のものを壊す。

### (2) 検証A〜D ＝ PASS済み

| 確認項目 | 実測                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| 完走記録 | 「/connectスライス完了。**検証A〜D 完走（2026-08-18）**」（`docs/Cowork_引き継ぎ指示_Sentio_20260816.md` §5） |
| 手順書   | `docs/runbooks/2026-08-16_token-refresh-verification-run.md`                                                  |
| 判定     | `verdict = PASS: B-s2-1 / B-s2-3 実証完了`（同手順書 STEP 3・230行目）                                        |
| 意味     | B-s2-1（リフレッシュ成功で `expires_at` 前進）を本番実データで実証済み                                        |

**再実行は不要。** 検証D は**本番への書き込みを伴う唯一の手順**（センチネル値 UPDATE）であり、
完了済みの状態で新PCから再実行すると、本番の正しい `expires_at` を壊す。

### あわせて完了しているもの（スライスA切替）

`docs/runbooks/2026-08-18_slice-a-cutover.md` の6手順はすべて完了:

1. Vercel `SUPABASE_ANON_KEY`（Production / Preview 計5変数）— 完了
2. Auth 設定（Confirm email OFF）— 完了
3. アカウント作成と Google 再接続 — 完了・**A-1 PASS**
4. 旧検証用データの削除 — 完了（A案・Vault削除あり）
5. A-4 再連携動線の本番実証 — 完了・**A-4 PASS**（2026-08-19）
6. 法務文面の確認 — 完了（2026-08-19・草案表示は撤去済み）

---

## 新PCでの再現手順（この文書から導かれる最短経路）

1. Node.js `v24.13.1` / Git for Windows / GitHub CLI / Docker Desktop を入れる
2. `npm i -g pnpm@11.21.0` と `npm i -g @anthropic-ai/claude-code`
   2b. Deno `v2.1.4` を入れる（`pnpm run check:edge-types` に必要）。
   GitHub Releases の zip を `%USERPROFILE%\.deno\bin` へ展開し、そこを PATH に足す:
   `https://github.com/denoland/deno/releases/download/v2.1.4/deno-x86_64-pc-windows-msvc.zip`
   バージョンは CI と揃えること（最新版を入れない）
3. **Supabase CLI は global に入れない**（§1 の理由）
4. `git clone github.com/shotarokajitani/sentio` → `pnpm install`
   （これで `supabase@2.113.0` が `node_modules` に入る）
5. §2 の表 #1〜#8 を USB から所定パスへ戻す
6. §4「必ず移送する」の7項目を `C:\Users\shota\.claude\` 配下へ戻す
7. `claude` に再ログイン（`.credentials.json` は移送より再ログインが安全）
8. **§5 の2件は実行しない**

## 未確定（買い替え前に人間が決めること）

- **stash@{0} を破棄してよいか**（§3）。放置＝消滅。残すなら patch 化して移送する
