# service_role キーのローテーション（2026-08-20 登録・**手順書のみ。未実施**）

**実施日: 未定。** 2026-08-20 に「実施する。ただし今日ではない」と検収者が判断した。
本ファイルは手順書であって実施記録ではない。実施したら末尾に記録を足すこと。

## なぜ要るか

2026-08-20、`docs/secrets-runbook.md` の旧手順（複数行 PowerShell + `Read-Host`）を
実行する過程で、**本番の service_role キーが平文でチャットに貼られた**。
値そのものがセッション記録に残ったため、漏洩として扱う。

この鍵は `role: service_role` で、**RLS を完全にバイパスする**。
URL さえ分かれば全社のデータを読み書きできる。

**リポジトリへの混入は無い**（2026-08-20 実測）。追跡ファイルの JWT 様文字列は
`scripts/seed-synthetic-local.ts:10` の1件のみで、これは `iss: supabase-demo` の
ローカル用デモ鍵。CI の gitleaks（`fetch-depth: 0` で履歴全体を走査）も success。
**危険なのはリポジトリではなくセッション記録の方である。**

---

## いま実施すれば影響が小さい（根拠）

停止点0 で採った本番の実測（`docs/checklists/env-diff.md`）:

| テーブル       | 行数 |
| -------------- | ---- |
| `baselines`    | 0    |
| `delivery_log` | 0    |
| `budget_usage` | 0    |

**パイプラインは1件も動いていない。** したがって、ローテーション中に cron や
Edge Function が一時的に 401 になっても、失われる処理が無い。

> **ただしこの3行が「影響ゼロ」を全部保証するわけではない。**
> レガシー JWT のローテートは **`anon` キーも同時に変える**ため、
> **既存の全ユーザーセッションが無効になる**（下記）。
> それが誰に当たるかは上の3テーブルには出ない。**手順1 の事前計数で確かめること。**

---

## 押さえるべき副作用: **全ユーザーが強制ログアウトされる**

Supabase のレガシー JWT キーは、`anon` と `service_role` の
**両方が同じ JWT 秘密で署名されている**。ローテートするとその秘密が変わるので、
次の3つが同時に起きる。

1. **`service_role` キーが変わる** — これが本来の目的
2. **`anon` キーも変わる** — アプリ側の env を更新しないと、全リクエストが弾かれる
3. **発行済みのアクセストークンが全部無効になる** — **ログイン中のユーザーは全員ログアウト**

3 はデータを壊さない（再ログインで復帰する）が、**利用者がいるなら事前告知が要る**。
現時点で利用者がどれだけ居るかは手順1で数える。

---

## 更新先の一覧（**7箇所 + 記述1件**）

`docs/secrets-runbook.md` は「保管先は3箇所」と書いているが、**それは service_role だけの話**。
`anon` キーも同時に変わるので、実際に触る先はもっと多い。

### service_role キー

| #   | 保管先                                                   | 使う経路                                                                         | 誰が                                             | 更新しないと起きること                                                                                     |
| --- | -------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 1   | **Supabase 本体**（発行元）                              | すべての起点                                                                     | **人間**                                         | —                                                                                                          |
| 2   | **Vault `sentio_service_role_key`**                      | cron（`00020` の `sync-connections`）の `Authorization: Bearer`                  | **人間**（SQL Editor）                           | **どこにも出ない。** `net.http_post` は非同期で `cron.job_run_details` は succeeded のまま。毎日静かに 401 |
| 3   | **Edge Function 実行環境の `SUPABASE_SERVICE_ROLE_KEY`** | `resolveCaller` の `internal` 判定                                               | **Supabase が自動注入**（再デプロイ要否は手順7） | 全 Function が 401。パイプライン全停止                                                                     |
| 4   | **GitHub Secrets `SUPABASE_SERVICE_ROLE_KEY`**           | `invoke-function.yml`（手動実行）                                                | **人間**                                         | 手動実行が 401。**「封鎖が効いている」と誤読されやすい**のが一番の危険                                     |
| 5   | **Vercel env `SUPABASE_SERVICE_ROLE_KEY`**               | `src/app/auth/callback/google` / `.../freee` / `src/app/api/competitors/suggest` | **人間**                                         | OAuth コールバックと競合サジェストが 500                                                                   |

### anon キー（**同時に変わる**）

| #   | 保管先                                           | 使う経路                                                    | 誰が                    | 更新しないと起きること                                                      |
| --- | ------------------------------------------------ | ----------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------- |
| 6   | **Vercel env `SUPABASE_ANON_KEY`**               | `src/lib/supabase/server.ts`（3箇所）と `src/middleware.ts` | **人間**                | **アプリ全体が落ちる。** middleware は fail-closed なので全ページが弾かれる |
| 7   | **Edge Function 実行環境の `SUPABASE_ANON_KEY`** | `supabase/functions/_shared/caller.ts` の `anon` 判定       | **Supabase が自動注入** | anon 呼び出しの判定が壊れる                                                 |

### 記述のみ（値は持たない）

| #   | 対象                                         | 誰が     | すること                                                     |
| --- | -------------------------------------------- | -------- | ------------------------------------------------------------ |
| 8   | **env のサンプルファイル**（リポジトリ直下） | **人間** | 変数名の一覧が実態と合っているかを確認する。**値は書かない** |

> **サンプルファイルの中身は、この手順書を書いた時点で確認できていない。**
> エージェントは `.env` を含むパスを読めない（`.claude/hooks/block-env-read.mjs` が deny。
> Read ツールも権限設定で拒否される）。
> **梶谷さんの目で、変数名が下の実測一覧と一致しているかを見てほしい。**

### 変数名の実測（2026-08-20）— **`NEXT_PUBLIC_SUPABASE_ANON_KEY` は存在しない**

検収者の指示にはこの名前があったが、リポジトリを実測すると
**`NEXT_PUBLIC_` 接頭辞の環境変数は1つも使われていない。**

```
$ git grep -n "NEXT_PUBLIC_" | grep -v "^docs/"
.claude/rules/security.md:9:  ... NEXT_PUBLIC_に秘密を置かない        ← 規則の文言
supabase/functions/_shared/caller.ts:11: ... コメント内の言及
（実際の env 参照は 0件）

$ git grep -oE "process\.env\.[A-Z_]+" -- src/ | sort -u
process.env.SUPABASE_URL
process.env.SUPABASE_ANON_KEY
process.env.SUPABASE_SERVICE_ROLE_KEY
...

$ git grep -n "createBrowserClient" -- src/
（0件。サーバ側 createServerClient のみ）
```

**anon キーはブラウザに配られておらず、Vercel のサーバ専用 env に置かれている。**
これは `docs/spec/05_security.md:6`「Vercelはサーバー専用env。`NEXT_PUBLIC_`に秘密を置くこと禁止」
と一致する。**正しい名前は `SUPABASE_ANON_KEY`（接頭辞なし）である。**

---

## 手順

### 0. 事前準備（**人間**）

- 実施時間帯を決める。**cron 発火（JST 9 / 15 / 21 / 3 時）の直後**が望ましい。
  次の発火まで6時間の猶予ができる
- 利用者が居るなら**強制ログアウトの告知**をする

### 1. 事前計数 — 影響範囲を数える（**人間**・SQL Editor・読み取りのみ）

```sql
-- 強制ログアウトが誰に当たるかを数える。0 なら告知は不要。
select
  (select count(*) from auth.users)    as users,
  (select count(*) from auth.sessions) as active_sessions,
  (select count(*) from public.companies) as companies,
  (select count(*) from public.connections where status = 'connected') as live_connections;
```

`active_sessions` が 0 なら、副作用3（強制ログアウト）は誰にも当たらない。
`live_connections` が 0 でなければ、cron 停止中に取り込みが止まることを了解しておく。

### 2. 現行キーの指紋を控える（**人間**）

ローテート後に「本当に変わったか」を確かめるための対照。
手順は `docs/secrets-runbook.md`「静的一致の確認」の `fp` 関数。

**`len` / `tail` / `prefix` / `sha256` の4つだけを控える。値そのものは記録しない。**

### 3. Supabase でローテートする（**人間**）

`Settings → API Keys` の **「Legacy API Keys」タブ**。

```
https://supabase.com/dashboard/project/<project-ref>/settings/api-keys
```

**ここから先は時間との勝負になる。** ローテートした瞬間から、
更新していない保管先の経路は全部壊れている。手順4〜7 を続けて行うこと。

> **新形式（`sb_secret_...` / `sb_publishable_...`）への移行はここでやらない。**
> ゲートウェイの `verify_jwt` はレガシー JWT でしか動かず、新形式にすると
> S-4 で閉じた認証境界が外れる。詳細と未判断点は `docs/spec/07_open_items.md`
> 「レガシー JWT キーの廃止と、ゲートウェイ JWT 検証の依存」。
> **今回はレガシーのまま採り直すだけ。**

### 4. Vault を更新する（**人間**・SQL Editor）

`sentio_service_role_key` を新しい値にする。
手順は `docs/runbooks/2026-08-15_vault-secret-setup-procedure.md`「値を更新する場合」。

`sentio_supabase_url` は変わらないので触らない。

### 5. Vercel の env を更新する（**人間**）

**2つある。片方だけだと片肺で壊れる。**

| 変数名                      | 新しい値                           |
| --------------------------- | ---------------------------------- |
| `SUPABASE_SERVICE_ROLE_KEY` | 新しい service_role キー           |
| `SUPABASE_ANON_KEY`         | **新しい anon キー**（忘れやすい） |

`SUPABASE_URL` は変わらない。
**env を変えただけでは反映されない。** Production の再デプロイまで行うこと。

### 6. GitHub Secrets を更新する（**人間**）

```
gh secret set SUPABASE_SERVICE_ROLE_KEY --repo shotarokajitani/sentio
（プロンプトに値を貼る。コマンドライン引数で渡さない＝シェル履歴に残さない）
```

`SUPABASE_ACCESS_TOKEN` / `SUPABASE_PROJECT_REF` / `SUPABASE_DB_PASSWORD` は
**この鍵とは別物なので触らない。**

### 7. Edge Function の再デプロイ（**CI 経由。ただし要判断**）

`SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY` は Supabase が実行環境へ自動注入するので、
**値を手で入れる操作は無い。** 問題は「稼働中の関数が古い値を掴んだままか」である。

**これは未確認である**（`docs/secrets-runbook.md` にも「再デプロイが要るかは未確認」とある）。
安全側に倒すなら再デプロイする。

> **⚠ 現状、コード変更なしに再デプロイする経路が無い。**
> `deploy.yml` は `on: push: branches: [main]` **のみ**で `workflow_dispatch` を持たない
> （2026-08-20 実測）。つまり**再デプロイには main への push が要る**。
> ブランチ保護が入ったので直 push もできず、**PR を1本通す**しかない。
>
> `deploy.yml` に `workflow_dispatch` を足すかは**未判断**。足せば
> 「コードを変えずに再デプロイ」ができるが、手動デプロイの経路を開くことになり、
> `deploy.yml` 冒頭の「手動デプロイ禁止」という宣言と衝突する。
> **実施前に検収者の判断を仰ぐこと。**

### 8. 停止点2-a を採り直す（**人間**）

**ここを飛ばさないこと。** 手順4 で Vault を更新し損ねていても、
この検査を通すまでは誰も気づけない。

1. `docs/runbooks/2026-08-20_cron-bearer-key-match.sql` を SQL Editor で流す
2. `docs/secrets-runbook.md`「静的一致の確認」の `fp` で新しいキーの指紋を採る
3. **`key_len` / `key_tail` / `key_sha256` の3つが一致すること**
4. **`key_prefix` が `eyJ` であること**（新形式に変わっていないことの確認）
5. 手順2 で控えた**旧指紋と違っている**こと（＝本当にローテートされた）

結果は `docs/runbooks/2026-08-20_cron-bearer-key-match_result.md` と同じ形で記録する。
**`sha256` の値そのものは書かない。** このリポジトリは public である。

### 9. 実疎通を確認する（**人間**・停止点2-b と同じ）

```sql
select id, status_code, error_msg, created
  from net._http_response
 order by created desc
 limit 20;
```

- **cron**: 次の発火（JST 9 / 15 / 21 / 3 時）の**直後**に上を見る。`status_code` が 200。
  保持期間が短いので発火直後に見ること。
  **`cron.job_run_details` では判定できない**（`net.http_post` が非同期のため）
- **手動実行**: Actions → `invoke-function` を1回回して 2xx（GitHub Secrets の検算）
- **アプリ**: 本番 URL でログインできること（Vercel の `SUPABASE_ANON_KEY` の検算）。
  **強制ログアウトされているので再ログインになる**
- **ゲートウェイ**: 本番の Function URL へ認証なしで叩いて **401**（S-4-2 と同じ）

### 10. 記録する（**人間 + CC**）

- 本ファイルの末尾に実施記録を足す（日付・実施者・各手順の結果）
- `docs/incident.md` に漏洩と対応を記録する
- **旧キーの指紋も新キーの指紋も、値そのものは書かない**

---

## 誰が何をするか

| 手順 | 内容                        | 区分                                    |
| ---- | --------------------------- | --------------------------------------- |
| 0    | 実施時間帯の決定・告知      | **人間**                                |
| 1    | 事前計数（SQL）             | **人間**                                |
| 2    | 現行キーの指紋を控える      | **人間**                                |
| 3    | Supabase でローテート       | **人間**                                |
| 4    | Vault 更新                  | **人間**（SQL Editor）                  |
| 5    | Vercel env 2件 + 再デプロイ | **人間**                                |
| 6    | GitHub Secrets 更新         | **人間**                                |
| 7    | Edge Function 再デプロイ    | **CI 経由**（ただし経路が無い。要判断） |
| 8    | 停止点2-a の採り直し        | **人間**                                |
| 9    | 実疎通の確認                | **人間**                                |
| 10   | 記録                        | **人間 + CC**                           |

**エージェントは鍵の値に一切触らない。** CC ができるのは、
実施後の記録の整形と、CI / deploy の監視・結果引用だけである。

---

## 失敗したときの戻し方

**レガシー JWT キーのローテートは元に戻せない。** 旧キーは復元できない。
したがって「戻す」のではなく「進んで直す」しかない。

どこかで詰まった場合、**壊れているのは必ず「更新し損ねた保管先」の経路**である。
症状から逆引きすること。

| 症状                                                 | 更新し損ねている先                              |
| ---------------------------------------------------- | ----------------------------------------------- |
| アプリ全体が落ちる / 全ページで弾かれる              | #6 Vercel `SUPABASE_ANON_KEY`                   |
| OAuth コールバックだけ 500                           | #5 Vercel `SUPABASE_SERVICE_ROLE_KEY`           |
| cron が毎日静かに 401（`net._http_response` で 401） | #2 Vault                                        |
| 手動実行だけ 401                                     | #4 GitHub Secrets                               |
| 全 Function が 401                                   | #3 Edge Function 実行環境（手順7 の再デプロイ） |

---

## 実施記録

**未実施。** 実施したらここに追記する。
