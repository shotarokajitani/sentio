# Stripe の設定手順（**梶谷さんの作業**）— 2026-09-02

コード側は入っている。**動き出すのに要るのは、この手順書の作業だけである。**
`docs/spec/09_pricing.md` の決定（2段構成・標準は月3万円）が前提。

**この手順は秘密の実値を扱う。** 値をこのファイルにも、会話にも、ログにも書かないこと。

## 1. Stripe ダッシュボードで商品を作る

- 商品名: 任意（利用者に見える）
- 価格: **月額 3万円**・日本円・**継続（サブスクリプション）**
- 作成後に **Price ID** を控える（`price_` で始まる）

試用プランは Stripe に商品を作らない。**0円で、購読が無い状態がそれに当たる。**

## 2. Webhook を登録する

- 送信先: `https://<本番のドメイン>/api/billing/webhook`
- 送るイベント: 最低限この3つ
  - `checkout.session.completed`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
- 登録後に **署名シークレット**を控える

## 3. Vercel に環境変数を入れる（Production と Preview）

| 変数 | 中身 |
| --- | --- |
| `STRIPE_SECRET_KEY` | Stripe のシークレットキー |
| `STRIPE_PRICE_STANDARD` | 手順1の Price ID |
| `STRIPE_WEBHOOK_SECRET` | 手順2の署名シークレット |
| `NEXT_PUBLIC_SITE_ORIGIN` | `https://<本番のドメイン>`（Checkout の戻り先に使う） |

**Preview にも入れておくと、本番に出す前に通しで試せる。**
入れないと `/api/billing/checkout` が 500（設定の欠落）を返す——
これは仕様であり、**設定が無いまま黙って動かないため**である。

## 4. 通しで確かめる（Preview 推奨）

1. `/connect` を開き、購読の導線から Stripe の画面へ飛ぶ
2. Stripe の**テストカード**で購読を確定する
3. `/connect?billing=done` に戻る
4. **Supabase の Authentication → Users** でそのユーザーの
   `user_metadata.subscription.status` が `active` になっていることを見る

4 が変わっていなければ webhook が届いていない。Stripe の Webhook ログで
配信の成否と応答コードを見る。**401 なら署名シークレットの不一致**である。

## 5. 済んだら、こちらに伝えること

`DEFAULT_PLAN` を `TRIAL_PLAN` に倒す作業が残っている（`_shared/budget.ts`）。

**いまは購読が無い会社も標準（10回）である。** 購読という概念が無い間に試用へ倒すと、
**いまいる会社の枠を黙って 10 → 3 に減らす**ことになるためで、
Stripe が回り始め、既存の会社に購読が付いてから倒す。

## 既知の罠

- **`billing_address_collection` と `customer_creation` を渡さない**（CLAUDE.md の絶対規則）。
  サブスクリプションでこの2つを渡すと 500 になることが既知である。コード側では渡していない
- 署名検証は**生の本文**で行う。本文を先にパースして組み直すと必ず不一致になる
