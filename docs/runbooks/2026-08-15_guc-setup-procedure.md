# GUC設定手順（`app.settings.*`）— 関門2・人間実行

**この手順は秘密（`service_role_key`）の実値を扱うため、関門2「秘密・課金・外部アカウントに
触る操作の承認」に該当する。Claude Code は実行しない。**

対象: 前提確認SQL（`2026-08-15_token-refresh-prereq-check.sql`）の
**seq 6 / seq 7 が `NG: 未設定`** だった場合のみ実施する。`OK` なら何もしない。

---

## なぜ必要か

`00018_pg_cron_sync_connections.sql` が登録した cron ジョブの本文は、実行のたびに

```
current_setting('app.settings.supabase_url')
current_setting('app.settings.service_role_key')
```

を参照する。**この2つが未設定でも、マイグレーションの適用は成功する。**
失敗するのは6時間ごとのcron実行時だけで、しかも
`cron.job_run_details` を見に行かない限り誰にも気づかれない。
「静かな失敗」の典型なので、適用直後に必ず潰しておく。

---

## 事前に読むこと（設計上の申し送り）

この方式は **service_role_key をデータベース設定として保存する**。
Sentioの絶対規則「OAuthトークンはVault以外のどこにも置かない」の直接の対象は
コネクタのトークン（K2）であり `service_role_key` ではないため、規則違反ではない。
ただし以下は理解した上で採用すること。

- 値は `pg_db_role_setting` に平文で入り、`pg_settings` 等から superuser には読める
- ダンプ・バックアップに含まれうる
- ローテーション時はこの設定も同時に更新する必要がある（更新漏れでcronだけ静かに壊れる）

**より安全な代替**: cron本文を書き換え、`service_role_key` を Vault から
security definer 関数経由で取得する形にする（`00012` / `00017` のヘルパーと同じ流儀）。
そうすれば秘密の保管先がVaultに一本化される。
ただしこれは `00018` の変更＝本番適用済みマイグレーションの修正になるため、
**別途の判断事項**として扱う。今回はまず現行方式で疎通させ、
ローテーション運用を設計する時点で再検討するのが妥当。

---

## 手順

### 1. 値を用意する

- **supabase_url**: `https://<project-ref>.supabase.co`
  Dashboard > Project Settings > Data API > Project URL の値
- **service_role_key**: Dashboard > Project Settings > API Keys > `service_role`（Reveal で表示）

> **秘密の実値をチャット・コミット・Issue・ログに貼らないこと。**
> 以下のSQLは Dashboard > SQL Editor に直接入力し、実行後にエディタの内容を消す。
> SQL Editor の実行履歴に残る点にも留意する（気になる場合は履歴を削除する）。

### 2. SQL Editor で実行する

`<...>` の2箇所を実値に置き換えてから実行する。
**`ALTER DATABASE` は DDL であり読み取り専用ではない。** ここが唯一の書き込み操作。

```sql
ALTER DATABASE postgres SET app.settings.supabase_url      = '<https://xxxx.supabase.co>';
ALTER DATABASE postgres SET app.settings.service_role_key  = '<service_role キーの実値>';
```

### 3. 新しいセッションで反映を確認する

**`ALTER DATABASE ... SET` は既存セッションには効かない。** 必ず
SQL Editor のタブを開き直す（または少し待って新規接続になってから）確認すること。
ここを飛ばすと「設定したのに未設定に見える」で無駄に往復する。

```sql
SELECT
  current_setting('app.settings.supabase_url', true)                 AS supabase_url,
  current_setting('app.settings.service_role_key', true) IS NOT NULL AS has_service_role_key;
-- 期待結果: supabase_url が https://<project-ref>.supabase.co / has_service_role_key = true
-- ※ 値そのものは絶対に表示・記録しないこと（IS NOT NULL のみ）
```

### 4. 前提確認SQLを再実行する

`2026-08-15_token-refresh-prereq-check.sql` を通しで流し直し、
**seq 6 / seq 7 が `OK` になったこと**を確認する。

### 5. cronの実際の疎通を確認する（次回発火後）

cronは UTC 00:00 / 06:00 / 12:00 / 18:00 に発火する（JST 09:00 / 15:00 / 21:00 / 03:00）。
**次の発火を待ってから**、前提確認SQLの seq 8「(参考) cron実行実績」が
`INFO: 未発火` から `OK` に変わることを確認する。

`NG: cron実行が失敗している` になった場合は、同行の「直近エラー」を添えて報告すること。
`unrecognized configuration parameter` が出ていれば、手順2の設定先データベースが
違う（`postgres` 以外に入れた）可能性が高い。

---

## 完了後

この手順で設定した2つのGUCは、**service_role キーをローテーションしたら必ず更新する**。
更新を忘れると、Sentio本体は動いたままcronだけが静かに止まる。
`docs/secrets-runbook.md` のローテーション手順にこの項目が含まれているか確認すること。
