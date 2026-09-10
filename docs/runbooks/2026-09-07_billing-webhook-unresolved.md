# 会社を引けなかった課金 webhook が出たとき（`billing_webhook_unresolved`）

**この表に行が入ったら、購読の状態が本番と食い違っている可能性がある。**
入った行は `dispatch-daily` が毎日数え、1件以上あれば運用宛にメールが1通出る。
**対処して `resolved_at` を埋めるまで、毎日出続ける。**

## この表に入る条件は4つだけ

| `reason`          | 何が起きたか                                                                  | まず疑うもの                              |
| ----------------- | ----------------------------------------------------------------------------- | ----------------------------------------- |
| `not_found`       | `customer` に**一致する会社が無い**（0件）                                    | checkout を経ずに Stripe 側で作られた購読 |
| `ambiguous`       | **2社以上が同じ customer id を持っている**（どちらにも書かない）              | データの壊れ。片方が誤り                  |
| `lookup_failed`   | 逆引きそのものが失敗した（権限・DB障害）。**「引けなかった」とは別である**    | RPC の GRANT、DB の障害                   |
| `retrieve_failed` | 会社は引けたが、Stripe から Subscription を取り直せなかった（解約通知を除く） | Stripe 側の一時的な不調                   |

**応答は理由で分かれる**（2026-09-07 変更）。

| 場合                                                                  | 応答    | 意味                                                 |
| --------------------------------------------------------------------- | ------- | ---------------------------------------------------- |
| `retrieve_failed` / `lookup_failed`（`customer.subscription.*` のみ） | **503** | **Stripe が再送する。** 再送で直れば行は自動で閉じる |
| `not_found` / `ambiguous`                                             | 200     | 再送しても直らない。**人が対処するまで変わらない**   |
| 解約（`deleted`）で取り直せなかった場合                               | 200     | `canceled` を書いて解決済み。そもそも行が残らない    |

**5xx が続けば、Stripe から「webhook が失敗している」通知が届く。** 気づく経路がもう1つある。
一方 200 で受けたものは **Stripe 側から見れば成功**なので、ダッシュボードには何も出ない。
その場合に気づく経路はこの表と毎日のメールだけである。

**Stripe の再送は本番で最大3日・指数バックオフである。** 3日を過ぎると諦める。
`dispatch-daily` の summary はそれを `billing_stale` として別枠で出す
（**「再送中でまだ望みがある」と「再送が尽きた」を混ぜないため**）。

## 手順

### 1. 何が入っているかを見る

```sql
select stripe_event_id, event_type, reason, stripe_customer_id, created_at
  from billing_webhook_unresolved
 where resolved_at is null
 order by created_at;
```

**ペイロード本体は保存していない。** 中身が要るときは Stripe のダッシュボードで
`stripe_event_id` を引く（Developers → Events）。

### 2. `reason` ごとに切り分ける

#### `not_found` / `ambiguous` の場合

その `stripe_customer_id` を持つ会社が居るかを確かめる。

```sql
select id,
       raw_user_meta_data -> 'subscription' ->> 'stripe_customer_id' as customer_id,
       raw_user_meta_data -> 'subscription' ->> 'status'             as status
  from auth.users
 where raw_user_meta_data -> 'subscription' ->> 'stripe_customer_id' = '<customer_id>';
```

- **0件** — checkout を経ずに Stripe 側だけで購読が作られた可能性が高い。
  Stripe 側で `client_reference_id` に会社IDが入っているかを確かめる。
  結び付けるべき会社が特定できたら、その会社の
  `user_metadata.subscription.stripe_customer_id` を埋める（3へ）
- **2件以上** — **同じ customer id が複数の会社に付いている。**
  逆引きは意図的に NULL を返す（当てずっぽうで1社に書かない）。
  どちらが正しいかを Stripe 側の記録で確かめ、誤っているほうを消す

#### `retrieve_failed` / `lookup_failed` の場合

`retrieve_failed` は Stripe 側の一時的な不調であることが多い。`lookup_failed` は**こちら側の障害**（RPC の権限が剥がれた・DB が落ちた）なので、同じ日に大量に入る。**1件ずつ追う前に、逆引きが動くことを先に確かめること。**
どちらも**購読の状態が更新されていないだけ**なので、
Stripe の現在値を見て、必要なら手で合わせる（3へ）。

### 3. 状態を合わせる（必要な場合のみ）

**Sentio は何も勝手に送らない・登録しない。** ここは人が確かめてから実行する。

```sql
-- 例: 解約が反映されていなかった場合
update auth.users
   set raw_user_meta_data = jsonb_set(
         raw_user_meta_data, '{subscription,status}', '"canceled"'
       )
 where id = '<company_id>';
```

### 4. 対処済みにする（**これを忘れると毎日鳴り続ける**）

**再送で直った行は、webhook 側が自動で `resolved_at` を埋める。** 手で埋めるのは
`not_found` / `ambiguous` のように、人が状態を合わせた行である。

```sql
update billing_webhook_unresolved
   set resolved_at = now()
 where stripe_event_id = '<event_id>';
```

### 5. 消えたことを確認する

```sql
select count(*) from billing_webhook_unresolved where resolved_at is null;
```

翌日の `dispatch-daily` の応答が `"billing_alert":"not_needed"` に戻ることも確かめる。

## 守れない範囲（設計上の限界）

1. **この表は `company_id` を持たない。** 会社が引けなかった事実を記録する表なので、
   持ちようがない。その帰結として **`check:deletion-coverage` の射程外**であり、
   **アカウント削除でこの表の行は消えない。** 残るのは Stripe の customer id と
   event id だけで、氏名・メール・金額・ペイロード本体は入らない
2. **メールが出るのは1日1回である。** 即時ではない。
   即時に鳴らす経路（Sentry 等）は本番に存在しない
   （`docs/spec/07_open_items.md`「本番の可観測性が実質ゼロ」）
3. **`SENTIO_OPS_EMAIL` が未設定なら、メールは出ない。**
   ただしその場合も `dispatch-daily` は `"billing_alert":"not_configured"` を返して
   non-2xx になる。**黙って0件に見せることはしない**
