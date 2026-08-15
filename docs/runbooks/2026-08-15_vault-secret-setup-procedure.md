# Vaultシークレット登録手順 — 関門2・人間実行

**この手順は秘密（`service_role_key`）の実値を扱うため、関門2「秘密・課金・外部アカウントに
触る操作の承認」に該当する。Claude Code は実行しない。**

対象: 前提確認SQL（`2026-08-15_token-refresh-prereq-check.sql`）の
**seq 6 / seq 7 が `NG: 未登録`** の場合に実施する。

経緯: 当初はGUC（`ALTER DATABASE ... SET app.settings.*`）方式を予定していたが、
本番で `ERROR: 42501: permission denied to set parameter` となり**経路自体が塞がっていた**。
詳細は `2026-08-15_guc-setup-procedure.md` を参照。Vault方式に移行した。

---

## シークレット名（`00020` と完全一致・変更禁止）

| 用途              | シークレット名            |
| ----------------- | ------------------------- |
| プロジェクトURL   | `sentio_supabase_url`     |
| service_role キー | `sentio_service_role_key` |

`00020_cron_vault_secrets.sql` の `c_secret_url` / `c_secret_key` がこの名前を持つ。
**名前が1文字でも違うと、cron が `vault secret not found: <name>` で失敗する**
（未登録を黙って握り潰さず、名前をログに出して落ちる設計にしてある）。

---

## 前提

`00020` が本番に適用済みであること（deploy ワークフロー完了後）。
未適用の状態で登録しても害はないが、cron 本文がまだ GUC 版のままなので疎通しない。

## 手順

### 1. 値を用意する

- **`sentio_supabase_url`**: `https://<project-ref>.supabase.co`
  Dashboard > Project Settings > Data API > Project URL
  **末尾のスラッシュを付けないこと。** cron 本文が `|| '/functions/v1/sync-connections'` と
  連結するため、付けると `//functions/v1/...` になる
- **`sentio_service_role_key`**: Dashboard > Project Settings > API Keys > `service_role`（Reveal）

> **秘密の実値をチャット・コミット・Issue・ログに貼らないこと。**
> 下記SQLは Dashboard > SQL Editor に直接入力し、実行後にエディタの内容を消す。
> **SQL Editor の実行履歴に残る**点にも留意する（気になる場合は履歴を削除する）。

### 2. 登録する（SQL Editor）

`<...>` の2箇所を実値に置き換えて実行する。
`store_vault_secret` は `00012` で定義した security definer ヘルパー。

```sql
SELECT store_vault_secret(
  'sentio_supabase_url',
  '<https://xxxx.supabase.co>',
  'sync-connections cron が叩くプロジェクトURL'
);

SELECT store_vault_secret(
  'sentio_service_role_key',
  '<service_role キーの実値>',
  'sync-connections cron の Authorization ヘッダ用'
);
```

> **注意: この登録は1回だけ行うこと。同名での再実行はしない。**
> `vault.secrets.name` に一意制約があるかは Vault のバージョンに依存し、
> 未検証（本番は読み取り専用で確認、ローカル再現はDocker不可のため未実施）。
> 再実行すると、環境によって
> **(a) 重複行ができる** か **(b) unique 違反で失敗する** のどちらかになる。
>
> (a) に倒れた場合でも安全側に落ちるよう、`read_vault_secret_by_name` は
> 同名が2件以上あれば `vault secret name is ambiguous (N rows): <name>` で
> **明示的に失敗する**（どれか1件を黙って選ぶと、ローテーション時に
> 「古い値を使い続ける」が誰にも気づかれずに起きるため）。
>
> 値を差し替えたい場合は、下の「値を更新する場合」を使うこと。

### 3. 登録を確認する（値は表示されない）

```sql
SELECT name, created_at, updated_at
FROM vault.secrets
WHERE name IN ('sentio_supabase_url', 'sentio_service_role_key')
ORDER BY name;
-- 期待結果: 2行ちょうど。secret 列は選択していないため実値は出ない
```

### 4. 前提確認SQLを再実行する

`2026-08-15_token-refresh-prereq-check.sql` を通しで流し直し、
**seq 6 / seq 7 が `OK`**（かつ重複なし）になったことを確認する。

### 5. cron の疎通を確認する（次回発火後）

cron は UTC 00:00 / 06:00 / 12:00 / 18:00（JST 09:00 / 15:00 / 21:00 / 03:00）に発火する。
次の発火を待ってから前提確認SQLの seq 8 が `OK` になることを確認する。

`NG` の場合は同行の「直近エラー」を添えて報告すること。よくある原因:

| エラー                                                     | 原因                                      |
| ---------------------------------------------------------- | ----------------------------------------- |
| `vault secret not found: sentio_...`                       | 名前の不一致、または未登録                |
| `permission denied for function read_vault_secret_by_name` | cronジョブの所有者が postgres でない      |
| HTTPエラー系                                               | URL末尾のスラッシュ、またはキーの取り違え |

---

## 値を更新する場合（キーのローテーション時）

**`store_vault_secret` を再実行してはいけない**（重複行ができる）。
`00017` の `update_vault_secret` を使う。UUID が要るので先に引く。

```sql
-- ① 対象のIDを引く（値は表示されない）
SELECT id, name FROM vault.secrets WHERE name = 'sentio_service_role_key';
```

```sql
-- ② 値を差し替える（<...> を実値に置換）
SELECT update_vault_secret('<①で得たUUID>', '<新しい service_role キー>');
```

service_role キーをローテーションしたら**必ずこの更新も行う**。
忘れると Sentio 本体は動いたまま cron だけが静かに止まる。
`docs/secrets-runbook.md` のローテーション手順にこの項目が含まれているか確認すること。
