# アカウント削除の運用手順（2026-08-20 登録・**人間作業**・当面は手作業）

実行者: **梶谷さん**（Supabase Dashboard の SQL Editor）。
根拠: プライバシーポリシー §6「アカウントを削除する場合」
（`src/app/privacy/page.tsx`）。**公開した約束なので、依頼が来たら必ずこの手順で実行する。**

## 約束した内容（守る対象）

> アカウントの削除は support@mdc-diseno.com へのご連絡で承ります。
> ご本人であることを確認のうえ、**ご依頼から30日以内に**、当該アカウントに紐づく
> すべてのデータ（Google ユーザーデータ、認証情報、生成された分析結果を含む）を削除します。
> 削除の完了はメールでご報告します。

守るべき点は4つ。**本人確認**／**30日以内**／**すべてのデータ**／**完了報告**。

## なぜ手作業なのか

削除APIは未実装である（`docs/spec/07_open_items.md` に登録済み）。
アカウント削除は**取り返しがつかない**うえ、本人確認という人間の判断を含む。
自動化を急いで誤削除するより、件数が少ないうちは手作業で確実に行う。

**自動化されるまでは、この手順書が唯一の実行経路である。**

---

## 手順

### 1. 本人確認（**人間の判断**）

- 依頼メールの送信元アドレスが、当該アカウントの**ログインメールと一致**していること
- 一致しない場合は、**アカウントのログインメール宛に確認メールを送り、そこから返信を得る**
- 一致の確認が取れるまで先へ進まない

### 2. 対象の特定と、消す前の計数（読み取りのみ）

```sql
-- <EMAIL> を依頼者のメールアドレスに置き換える
with target as (
  select id from auth.users where email = '<EMAIL>'
)
select
  (select id::text from target)                                                as company_id,
  (select count(*) from public.events        e, target t where e.company_id = t.id) as events,
  (select count(*) from public.entities      x, target t where x.company_id = t.id) as entities,
  (select count(*) from public.baselines     b, target t where b.company_id = t.id) as baselines,
  (select count(*) from public.narratives    n, target t where n.company_id = t.id) as narratives,
  (select count(*) from public.company_summary s, target t where s.company_id = t.id) as summaries,
  (select count(*) from public.findings      f, target t where f.company_id = t.id) as findings,
  (select count(*) from public.connections   c, target t where c.company_id = t.id) as connections,
  (select count(*) from public.delivery_log  d, target t where d.company_id = t.id) as delivery_log,
  (select count(*) from public.budget_usage  u, target t where u.company_id = t.id) as budget_usage,
  (select count(*) from public.misjudgments  m, target t where m.company_id = t.id) as misjudgments;
```

**この件数を依頼メールのスレッドに控えてから消す。** 消した後では数えられない。
`company_id` が1行も返らない場合、そのメールのアカウントは存在しない。依頼者に確認する。

### 3. Vault のトークンを破棄する

`connections` を消す前に行う。先に行を消すと `vault_secret_id` が分からなくなり、
**Vault に値だけが残る**。

```sql
select public.delete_vault_secret(c.vault_secret_id)
  from public.connections c
  join auth.users u on u.id = c.company_id
 where u.email = '<EMAIL>'
   and c.vault_secret_id is not null;
```

`true` が返った件数 ＝ 実際に破棄した本数。`false` は元から無かったもの。

### 4. データを消す

```sql
begin;

with target as (select id from auth.users where email = '<EMAIL>')
delete from public.events        where company_id in (select id from target);
-- 以下、同じ形で
delete from public.entities        where company_id in (select id from auth.users where email = '<EMAIL>');
delete from public.baselines       where company_id in (select id from auth.users where email = '<EMAIL>');
delete from public.narratives      where company_id in (select id from auth.users where email = '<EMAIL>');
delete from public.company_summary where company_id in (select id from auth.users where email = '<EMAIL>');
delete from public.findings        where company_id in (select id from auth.users where email = '<EMAIL>');
delete from public.connections     where company_id in (select id from auth.users where email = '<EMAIL>');
delete from public.delivery_log    where company_id in (select id from auth.users where email = '<EMAIL>');
delete from public.budget_usage    where company_id in (select id from auth.users where email = '<EMAIL>');
delete from public.misjudgments    where company_id in (select id from auth.users where email = '<EMAIL>');

-- ここで手順5の確認クエリを流し、全部 0 になっていることを見てから commit する
-- 想定と違ったら rollback;
commit;
```

> **`begin;` … `commit;` で囲むこと。** 途中で想定外の件数に気づいたら `rollback;` で戻せる。
> 囲まずに流すと、気づいた時点で既に消えている。

### 5. 消えたことを確認する

手順2 の計数クエリをもう一度流す。**`company_id` 以外がすべて 0** であること。

### 6. 認証情報を消す

データを消し終えてから最後に行う。先に消すと `auth.users` から `company_id` を
引けなくなり、手順2〜5 が実行できない。

Supabase Dashboard → Authentication → Users → 該当ユーザー → Delete user。

### 7. 完了を報告する（**約束した義務**）

依頼者へ返信する。**削除した件数は書かない**（相手の手元に残す情報を増やさない）。

```text
Sentio をご利用いただきありがとうございました。

ご依頼のありましたアカウントの削除が完了しました。
Google カレンダー等の連携トークン、取り込んだデータ、生成された分析結果を含め、
当該アカウントに紐づくデータをすべて削除しております。

なお、バックアップに一時的に残る場合がありますが、最長35日で世代交代し、
その時点で失われます。バックアップから復元することはありません。
```

### 8. 記録する

本ファイルの末尾に**日付・実施者・本人確認の方法**を追記する。
**メールアドレスは書かない。** 個人を特定する値をリポジトリに残さない。

---

## やってはいけないこと

- **`where` を付けずに `delete` を流す。** 全社のデータが消える
- **メールアドレスの前方一致（`like`）で対象を引く。** 別人を巻き込む
- **`auth.users` を先に消す。** 参照が切れて残りのデータが孤児になる
- **削除件数を依頼者に伝える。** 求められていない情報を出さない
- **本人確認が取れないまま実行する。** 第三者による削除依頼は攻撃になりうる

## 自動化するときの条件

`docs/spec/07_open_items.md`「アカウント削除APIの実装」に登録済み。
自動化する場合も、**本人確認と、消す前の計数と、想定超過での停止**は残すこと。
`src/app/api/connections/disconnect/route.ts` の `evaluateDeletion` が同じ形の門を持っている。

## 実施記録

**未実施。** 依頼を受けたらここに追記する。
