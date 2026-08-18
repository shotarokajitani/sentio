# スライスA 本番切替 手順書（2026-08-18）

認証導入にあたり、本番で人間が行う作業と、その前後で機械が確認することをまとめる。
本番への直接操作は行わない（`CLAUDE.md` 絶対規則）。以下のSQLは**提示であって実行ではない**。

## 前提

- RLSポリシー（`00019`）は全テーブルで `company_id = auth.uid()`。
  つまり**1認証ユーザー＝1社**で、company_id は認証ユーザーIDそのもの
- 旧デモ会社 `00000000-0000-0000-0000-000000000001` に対応する認証ユーザーは**存在しない**。
  したがって旧データは、認証を入れた時点で**誰のセッションからも見えなくなる**（service_role を除く）

## 実施状況（2026-08-18・検収者が本番で実施）

| 手順                              | 状態                                                   |
| --------------------------------- | ------------------------------------------------------ |
| 1. Vercel `SUPABASE_ANON_KEY`     | **完了**（Production / Preview、計5変数）              |
| 2. Auth 設定（Confirm email OFF） | **完了**（signup許可ON・EmailプロバイダEnabledは維持） |
| 3. アカウント作成と Google 再接続 | **完了・A-1 PASS**（下記）                             |
| 4. 旧検証用データの削除           | **完了・A案で実施**（下記）                            |
| 5. A-4 再連携動線の本番実証       | **完了・A-4 PASS**（2026-08-19・下記）                 |
| 6. 法務文面の確認                 | 未実施（`legal.draftNotice` は表示したまま）           |

### 手順3の実測 ＝ A-1 PASS

- 新規サインアップ成功。**`/login?confirm=1` に落ちなかった**。
  これは Confirm email OFF が効いていることと、`SUPABASE_ANON_KEY` が
  本番ビルドに実効していることの両方の証跡になる（→ **A-1-1**）
- Google 再接続後、`/register/complete` に **15件** の取り込み件数が表示された（→ **A-1-4**）

### 手順4の実測 ＝ A案（Vault削除あり）で完了

- **Vault への DELETE 権限プローブは「可能」だった。**
  `00022` が記録した「`vault.secrets` への UPDATE は
  `permission denied for table secrets`」と**非対称**である。
  UPDATE 不可・DELETE 可という組み合わせは推測では当てられないため、
  この事実は `.claude/skills/gotchas` にも残した
- 孤児 Vault シークレットは **0件**。したがって 2-A-2（孤児掃除）は**実行不要だった**
- 事後確認（すべて実測）:
  - `connections` 残 **1件** — `985e6672…` / company `197f2c0e-aef8-405d-afcc-34d23c771fcd` / `active`
  - 旧デモ会社 `00000000-…-0001` の9テーブルはすべて **0件**
  - 旧接続が参照していた Vault 行は**消滅済み**
  - 新規に取り込んだ `events` **15件は無傷**
  - `events` の S0共有行（`company_id is null`）は**元から0件**だった
    （「消さない」設計の意図は変わらないが、今回は対象そのものが無かった）

### `delete_vault_secret` 関数は作らない（判断済み・2026-08-18）

Vault削除用の security definer 関数の新設を検討したが、
**DELETE が直接通ることが実測で分かったため不要**と判断した。着手しない。
将来 DELETE が拒否されるようになったら、この判断を見直すこと。

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
--
-- 列名の注意: connections に created_at は無い（00007 の定義は
-- id / company_id / provider / vault_secret_id / scopes / status /
-- last_refresh / expires_at の8列）。時系列で並べたいときは last_refresh を使う。
-- 接続IDを直書きせず参照関係で引くのは、新規に作った接続を取り違えないため
select id, company_id, provider, status, vault_secret_id, last_refresh, expires_at
  from connections
 order by last_refresh nulls first;

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

**4-2 の前に、Vault への DELETE 権限を実測すること。**
`00022` の実測で `vault.secrets` への直接 UPDATE は
`permission denied for table secrets` に落ちている。DELETE が通る保証は別問題なので、
必ずロールバックで終わるプローブで先に確かめる。

```sql
-- 4-1b. Vault への DELETE 権限プローブ。commit しないこと
begin;
  with created as (
    select vault.create_secret('probe-value',
             'probe:delete-permission:' || gen_random_uuid(), 'permission probe') as id
  )
  delete from vault.secrets where id in (select id from created);
  select 'DELETE 可能' as result;
rollback;
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

#### 実測（2026-08-19・検収者が Chrome 代行で実施・スクリーンショット証跡あり）＝ A-4 PASS

**取り消しは即失効ではない。** アクセストークンは自身の期限まで生き続けるため、
遷移は2段階に分かれた。

| #   | 時点                    | 観測                                                                             |
| --- | ----------------------- | -------------------------------------------------------------------------------- |
| 1   | 取り消し直後（期限内）  | Calendar API が **401**。`results` は `"error"`。**`status` は `active` のまま** |
| 2   | 期限5分前バッファ経過後 | `refresh failed: token endpoint returned 400` → **`reauth_required` へ遷移**     |
| 3   | `/connect`              | 「要再連携」バッジと「再接続」が表示された                                       |
| 4   | 再接続                  | `events` = **15件**、`active` に復帰（**2026-08-19 00:29 JST**）                 |

段階1で `status` が動かないのは実装どおりで、故障ではない。
`markReauthRequired` を呼ぶのは `_shared/token-refresh.ts` の**リフレッシュ失敗経路だけ**で、
`sync-connections/index.ts` の Calendar 同期が投げた例外は末尾の catch で
`status: "error"` を積むだけ（`markReauthRequired` を呼ばない）。
バッファは `EXPIRY_BUFFER_MS = 5 * 60 * 1000`。

ただし**利用者から見ると、この間は「接続済み」に見えたまま取り込みが止まる**。
改善候補として `docs/spec/07_open_items.md` に登録した（実装は未着手）。

**7日失効の時計は、この再接続（2026-08-19 00:29 JST）から数え直しになる。**

### 6. 法務文面の確認

`/privacy` と `/terms` は**草案**として実装済み。画面上に草案である旨を表示している。
法的確認が済んだら、その表示（`src/i18n/ja.ts` の `legal.draftNotice`）を外す。

## 機械側で確認済みのこと（実測）

- `pnpm typecheck` / `pnpm lint` / unit 179件 / `next build` 通過
- 未認証で `GET /api/connections` が 401（`tests/unit/connections-api-auth.test.ts`）
- 2ユーザー2社での越境不可（`tests/integration/connections-api.test.ts`、CIのintegrationジョブ）
- 本番 `https://sentio-9e2b.vercel.app/connect` に未ログインで入ると
  `/login?next=%2Fconnect` へ落ちる（`src/middleware.ts` の fail-closed が本番で実効）
- `pnpm run check:allowlist` は**担保になっていない**。CIでは1行 log を出すだけで
  実DBを照会しない（`docs/spec/07_open_items.md` に修正タスクを登録済み）。
  このリストから外したのはそのため

## 残る判断事項

`/register` にあった会社名・URLの入力欄は、**保存先がどこにも無く**入力しても捨てられていた。
運用ルール§6「実行不能な案内を出さない」に反するため撤去した。
一方 `docs/spec/04_act.md` のDay0 ①外から見た自社 / ②評判の座標 は会社名とURLを必要とする。
保存先（テーブル or `auth.users.raw_user_meta_data`）をどうするかは未確定。
テーブルを作る場合、マイグレーション＋RLS＋`00013`/`00014` への追記が必要になる。
