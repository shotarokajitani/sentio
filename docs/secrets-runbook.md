# secrets-runbook（値は一切書かない。値の正はパスワードマネージャ）

各鍵: [名称 / 分類K1-K4 / 使用箇所 / 発行元URL / ローテーション手順 / 影響範囲] の5点で管理する。
無停止ローテーション標準手順: 新鍵を併行登録 → 参照切替 → 動作確認 → 旧鍵失効。

対象一覧（初期）: ANTHROPIC_API_KEY(dev/prod) / STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET /
RESEND_API_KEY / SLACK_CLIENT_ID・SECRET / CHATWORK_CLIENT_ID・SECRET / GOOGLE_CLIENT_SECRET /
GBIZINFO_TOKEN / ESTAT_APP_ID / (追加時にここへ行を足す)
顧客トークン: Vaultのみ。運用は 05_security.md の規則に従う。
年1確認: Vault移行手順の机上確認 / 全鍵の棚卸し / 緊急アクセスキットの有効性。

---

## Google OAuth クライアントシークレットは2箇所に併存する（2026-08-18 記録）

`GOOGLE_CLIENT_SECRET` は**同じ値を2つの保管先が別々に持つ**。片方だけ更新すると、
更新しなかった側の経路だけが静かに壊れる。

| 保管先                                                   | 使う経路                                                                    | 失敗したときの見え方                                                 |
| -------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Vercel env**（`sentio-9e2b` / Production and Preview） | 初回連携のコード交換（`/auth/callback/google`）                             | `/register?error=token_exchange_failed`                              |
| **Supabase Function Secrets**                            | **トークンリフレッシュ**（`sync-connections` → `_shared/token-refresh.ts`） | cron が6時間ごとに静かに失敗。Edge Function Logs に `invalid_client` |

### ローテーション手順（両方を必ず更新する）

1. GCP でシークレットを新規発行する。**旧シークレットはこの時点では削除しない**
   （GCPは同一クライアントに複数シークレットを併存できる。先に消すと稼働中の
   リフレッシュが即座に落ちる）
2. **Vercel env** の `GOOGLE_CLIENT_SECRET` を新しい値に更新 → Redeploy
3. **Supabase Function Secrets** の `GOOGLE_CLIENT_SECRET` を新しい値に更新
4. 次の cron 発火（UTC 0/6/12/18時 ＝ JST 9/15/21/3時）を待ち、
   **`net._http_response` の `status_code` が 200 である**ことを確認する

   ```sql
   select id, status_code, error_msg, created
     from net._http_response
    order by created desc
    limit 20;
   ```

   > **cron の実行記録（`cron.job_run_details`）では判定できない**（2026-08-20 判明）。
   > `net.http_post` は**リクエストをキューに入れて即座に `request_id` を返す非同期関数**で、
   > cron が実行する SQL は `SELECT net.http_post(...)`。**HTTP応答を待たずに成功する。**
   > つまり**リフレッシュが 401 や 500 で落ちていても cron 側は成功のまま**であり、
   > それを根拠に旧シークレットを削除すると、**気づかないまま連携が全滅する。**
   > `net._http_response` は**数時間で刈られる**ので、発火直後に見ること。
   > 刈られていた場合は Supabase ダッシュボードの `sync-connections` の
   > Invocations / Logs を代替経路として使う。

5. 4 を確認して初めて、GCP 側の旧シークレットを削除する

**手順4を飛ばして旧シークレットを消さないこと。** リフレッシュ側の更新漏れは
cron が失敗するまで表面化せず、**しかも cron は失敗しない**（上記のとおり非同期のため）。
`net._http_response` かダッシュボードの Logs を見ない限り気づけない。

> 関連: `sentio_service_role_key`（Vault）のローテーションも同種の落とし穴がある。
> `docs/runbooks/2026-08-15_vault-secret-setup-procedure.md` の「値を更新する場合」を参照。

---

## service_role キーの保管先は3箇所ある（2026-08-20 登録）

`GOOGLE_CLIENT_SECRET` と同じ形の事故が、service_role キーでも起きうる。
**同じ値を3つの保管先が別々に持つ。**片方だけ更新すると、更新しなかった側の経路だけが静かに壊れる。

| 保管先 | 使う経路 | 失敗したときの見え方 |
| ------ | -------- | -------------------- |
| **Vault `sentio_service_role_key`** | cron（`00020` の `sync-connections`）が送る `Authorization: Bearer` | **どこにも出ない。** `net.http_post` は非同期で、`cron.job_run_details` は succeeded のまま。`net._http_response.status_code` かダッシュボードの Invocations でしか気づけない |
| **Edge Function 実行環境の `SUPABASE_SERVICE_ROLE_KEY`**（Supabase が自動注入） | `resolveCaller` が `internal` 判定に使う突き合わせ相手 | 全 Function が 401。パイプライン全停止 |
| **GitHub Secrets `SUPABASE_SERVICE_ROLE_KEY`**（`invoke-function.yml` 用・2026-08-20 新設） | 手動実行ワークフロー | 手動実行が 401。**「封鎖が効いている」と誤読されやすい**のが一番の危険 |

`--no-verify-jwt` を17本すべてから外した（スライスS・S-4）ため、
不一致は**ゲートウェイ層**でも 401 になる。関数の中に入る前に落ちるので、
Function Logs にすら手掛かりが出ないケースがある。

### ローテーション手順（3箇所すべてを更新する）

1. Supabase ダッシュボードでキーをローテートする
2. **Vault** の `sentio_service_role_key` を更新する
   （手順: `docs/runbooks/2026-08-15_vault-secret-setup-procedure.md` の「値を更新する場合」）
3. **GitHub Secrets** の `SUPABASE_SERVICE_ROLE_KEY` を更新する
4. Edge Function 側は Supabase が自動注入するので操作不要。ただし**再デプロイが要るかは未確認**
5. 次の cron 発火（UTC 0/6/12/18 ＝ JST 9/15/21/3）を待ち、
   `net._http_response` の `status_code` が 200 であることを確認する
   （`cron.job_run_details` では判定できない。本ファイル上部の注意書きと同じ理由）
6. 手動実行ワークフロー（Actions → `invoke-function`）を1回回し、2xx を確認する

**3 を飛ばさないこと。** 手動実行は毎日走らないので、忘れても当分気づかない。
気づくのは「本番で急いで関数を1本叩きたい」ときで、いちばん困る瞬間になる。

### GitHub Secrets への登録（人間作業・梶谷さん）

**登録操作は人間の手で行う。**エージェントは値に触らない。

```
gh secret set SUPABASE_SERVICE_ROLE_KEY --repo shotarokajitani/sentio
（プロンプトに値を貼る。コマンドライン引数で渡さない＝シェル履歴に残さない）
```

またはダッシュボード: Settings → Secrets and variables → Actions → New repository secret。
名前は `SUPABASE_SERVICE_ROLE_KEY`（`invoke-function.yml` がこの名前で参照する）。

**先に済ませておくこと**: `invoke-function.yml` が 2xx の応答本文を run ログに出さない形に
なっていること（2026-08-20 の受入基準訂正）。順序が逆だと、最初の1回で本番会社の
データが Actions のログに残る。

### 静的一致の確認（merge 前の停止点2）

**invoke しないで確かめる。** デプロイ後の実疎通（`net._http_response`）とは別物で、
こちらは merge を止める条件。

1. `docs/runbooks/2026-08-20_cron-bearer-key-match.sql` を SQL Editor で流す
2. Q1 の `token_kind` で分岐する

   - **Vault 参照**（`read_vault_secret_by_name` が本文に在る。`00020` 適用後の正常な形）
     → Q2 の `key_len` / `key_tail` / `key_sha256` を採る
   - **リテラル埋め込み**（`00018` の残骸や手作業登録）
     → Q3 の同3項目を採る。**この場合は一致していても是正対象**。
       秘密が `cron.job.command` に平文で載っており、`cron.job` を読める者に見える。
       `00020` の `cron.schedule` を流し直して Vault 参照に寄せること
   - **判定不能** → 本文を目視する。貼り戻すときは `command_redacted` を使う

3. 突き合わせ相手（現行 service_role キー）の指紋を採る。
   ダッシュボード → Settings → API → service_role キーをコピーし、**ローカルで**ハッシュする

   ```powershell
   $k = Read-Host -AsSecureString "service_role key"
   $p = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
          [Runtime.InteropServices.Marshal]::SecureStringToBSTR($k))
   "len={0} tail={1} sha256={2}" -f $p.Length, $p.Substring($p.Length-4),
     ([BitConverter]::ToString(
        [Security.Cryptography.SHA256]::Create().ComputeHash(
          [Text.Encoding]::UTF8.GetBytes($p))) -replace '-','').ToLower()
   ```

   `Read-Host -AsSecureString` を使うのは、キーを PowerShell の履歴に残さないため。

4. `key_len` / `key_tail` / `key_sha256` の3つがすべて一致すれば合格。
   **`sha256` が一致していれば同じ値である。** `len` と `tail` は、
   ハッシュを採り違えたときに気づくための添え物として見る

5. 併せて `key_prefix` を見る。**`eyJ` ならレガシーJWT形式**で、
   ゲートウェイの `verify_jwt` を通る。`sb_secret_` 等で始まる新形式の場合、
   **ゲートウェイで弾かれる可能性がある**（未実測）。この場合は merge を止めて相談すること

**不一致だった場合**: Vault 側を現行キーに更新してから merge する。
不一致のままデプロイすると、`sync-connections` が翌朝から静かに 401 になる。
