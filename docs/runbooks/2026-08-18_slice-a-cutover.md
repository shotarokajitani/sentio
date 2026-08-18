# スライスA 本番切替 手順書（2026-08-18）

認証導入にあたり、本番で人間が行う作業と、その前後で機械が確認することをまとめる。
本番への直接操作は行わない（`CLAUDE.md` 絶対規則）。以下のSQLは**提示であって実行ではない**。

## 前提

- RLSポリシー（`00019`）は全テーブルで `company_id = auth.uid()`。
  つまり**1認証ユーザー＝1社**で、company_id は認証ユーザーIDそのもの
- 旧デモ会社 `00000000-0000-0000-0000-000000000001` に対応する認証ユーザーは**存在しない**。
  したがって旧データは、認証を入れた時点で**誰のセッションからも見えなくなる**（service_role を除く）

## 人間の作業（この順で行う）

### 1. Vercel の環境変数に `SUPABASE_ANON_KEY` を追加する（必須・最優先）

これまで本番アプリは service_role キーしか使っていなかった。
認証セッションは anon キーで扱うため、未設定だとログインも `/connect` も機能しない
（`src/middleware.ts` は fail-closed でログイン画面へ送る）。

- 値は Supabase Dashboard → Project Settings → API → `anon` `public` キー
- Production と Preview の両方に設定する
- 追加後、対象デプロイを再実行する（環境変数はビルド後に反映されない）

### 2. Supabase Dashboard の Auth 設定

- **Email 確認メール**: メール送達に依存させないため **OFF を推奨**。
  ON のままだと、サインアップ直後にセッションが発行されず
  （`src/app/api/auth/session/route.ts` は `/login?confirm=1` に落として待たせる）、
  Supabase 内蔵SMTPのレート制限に当たる
- **Site URL**: 本番ドメイン
- **Redirect URLs**: 本番ドメインと Vercel Preview のドメイン

### 3. 検収者アカウントの作成と Google 再接続

1. 本番の `/login` でメールアドレスとパスワードを入れて「新規登録」
2. `/connect` で「Google カレンダー」を接続
3. 接続後、`/register/complete` に取り込み件数が表示されることを確認

この時点で **A-1-1（本番でのサインアップ／ログイン）** と
**A-1-4（新アカウントでの再接続）** の実測証跡が取れる。

### 4. 旧検証用データの削除（SQL Editor）

**手順3の完了後に行う。** 先に消すと、比較対象が無い状態で切り替えることになる。

```sql
-- 4-1. 削除対象の確認（件数を目視してから次へ進む）
select id, company_id, provider, status, vault_secret_id
  from connections
 where id = '135619bb-ff0b-44a2-885f-65337aa3f4f3';

select 'events' as t, count(*) from events
 where company_id = '00000000-0000-0000-0000-000000000001'
union all select 'entities',        count(*) from entities        where company_id = '00000000-0000-0000-0000-000000000001'
union all select 'baselines',       count(*) from baselines       where company_id = '00000000-0000-0000-0000-000000000001'
union all select 'narratives',      count(*) from narratives      where company_id = '00000000-0000-0000-0000-000000000001'
union all select 'company_summary', count(*) from company_summary where company_id = '00000000-0000-0000-0000-000000000001'
union all select 'findings',        count(*) from findings        where company_id = '00000000-0000-0000-0000-000000000001'
union all select 'delivery_log',    count(*) from delivery_log    where company_id = '00000000-0000-0000-0000-000000000001'
union all select 'budget_usage',    count(*) from budget_usage    where company_id = '00000000-0000-0000-0000-000000000001'
union all select 'misjudgments',    count(*) from misjudgments    where company_id = '00000000-0000-0000-0000-000000000001';
```

```sql
-- 4-2. 削除。4-1 の vault_secret_id を控えてから実行する
-- Vaultシークレットは connections を消すと参照元を失う。先に id を握る
begin;

  -- 孤児になるVaultシークレットを消す（削除用のsecurity definer関数は未実装のため直接指定）
  delete from vault.secrets
   where id = (select vault_secret_id
                 from connections
                where id = '135619bb-ff0b-44a2-885f-65337aa3f4f3');

  delete from connections
   where id = '135619bb-ff0b-44a2-885f-65337aa3f4f3';

  delete from events          where company_id = '00000000-0000-0000-0000-000000000001';
  delete from entities        where company_id = '00000000-0000-0000-0000-000000000001';
  delete from baselines       where company_id = '00000000-0000-0000-0000-000000000001';
  delete from narratives      where company_id = '00000000-0000-0000-0000-000000000001';
  delete from company_summary where company_id = '00000000-0000-0000-0000-000000000001';
  delete from findings        where company_id = '00000000-0000-0000-0000-000000000001';
  delete from delivery_log    where company_id = '00000000-0000-0000-0000-000000000001';
  delete from budget_usage    where company_id = '00000000-0000-0000-0000-000000000001';
  delete from misjudgments    where company_id = '00000000-0000-0000-0000-000000000001';

commit;
```

> `events` の S0共有行（`company_id is null`）は**消さない**。
> 上のWHERE句は等値比較なのでNULL行に一致しない。意図どおり。

### 5. A-4（再連携動線）の本番実証

自然失効を待たない（`docs/runbooks/2026-08-07_token-refresh-verification.md` の方針変更）。

1. <https://myaccount.google.com/connections> で Sentio のアクセスを取り消す
2. `sync-connections` を実行（cron を待つか Dashboard から手動実行）
3. `connections.status` が `reauth_required` になることを確認
4. `/connect` に「要再連携」と「再接続」が出ることを確認
5. 「再接続」で `active` に戻ることを確認

### 6. 法務文面の確認

`/privacy` と `/terms` は**草案**として実装済み。画面上に草案である旨を表示している。
法的確認が済んだら、その表示（`src/i18n/ja.ts` の `legal.draftNotice`）を外す。

## 機械側で確認済みのこと（実測）

- `pnpm typecheck` / `pnpm lint` / unit 172件 / `pnpm run check:allowlist` / `next build` 通過
- 未認証で `GET /api/connections` が 401（`tests/unit/connections-api-auth.test.ts`）
- 2ユーザー2社での越境不可（`tests/integration/connections-api.test.ts`、CIのintegrationジョブ）

## 残る判断事項

`/register` にあった会社名・URLの入力欄は、**保存先がどこにも無く**入力しても捨てられていた。
運用ルール§6「実行不能な案内を出さない」に反するため撤去した。
一方 `docs/spec/04_act.md` のDay0 ①外から見た自社 / ②評判の座標 は会社名とURLを必要とする。
保存先（テーブル or `auth.users.raw_user_meta_data`）をどうするかは未確定。
テーブルを作る場合、マイグレーション＋RLS＋`00013`/`00014` への追記が必要になる。
