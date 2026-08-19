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
