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
  **Preview で試すときは送信先が変わる。** 手順4を先に読むこと
  （Preview は保護が掛かっており、素の URL では届かない）
- 送るイベント: 最低限この3つ
  - `checkout.session.completed`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
- 登録後に **署名シークレット**を控える

## 3. Vercel に環境変数を入れる（Production と Preview）

| 変数                      | 中身                                                  |
| ------------------------- | ----------------------------------------------------- |
| `STRIPE_SECRET_KEY`       | Stripe のシークレットキー                             |
| `STRIPE_PRICE_STANDARD`   | 手順1の Price ID                                      |
| `STRIPE_WEBHOOK_SECRET`   | 手順2の署名シークレット                               |
| `NEXT_PUBLIC_SITE_ORIGIN` | `https://<本番のドメイン>`（Checkout の戻り先に使う） |

**Preview にも入れておくと、本番に出す前に通しで試せる。**
入れないと `/api/billing/checkout` が 500（設定の欠落）を返す——
これは仕様であり、**設定が無いまま黙って動かないため**である。

## 4. Preview で通す前に — **Deployment Protection を抜ける**（2026-09-08 改訂）

> **この節の手順は 2026-09-08 に変えた。** 以前は bypass secret を
> **クエリパラメータで渡す**手順だったが、**その手順どおりに実行した結果、
> 2026-09-02 に Stripe の配信ログへトークン付きURLが残った。**
> **URL はログ・履歴・リファラに残る。ヘッダで渡せば残らない。**

**Preview には Vercel の Deployment Protection（SSO）が掛かっている。**
そのままでは POST が**アプリに届かない**。実測（2026-09-03）:

```
$ curl -s -o /dev/null -w "%{http_code} %{redirect_url}" -X POST     https://<Preview のドメイン>/api/billing/webhook
302 https://vercel.com/sso-api?url=...%2Fapi%2Fbilling%2Fwebhook&nonce=...
```

### いまの状態（2026-09-08）

**secret は削除済みである。この節の手順はいま通らない。**
ラベルは「Stripe webhook — Preview 検証用（2026-09-03発行・検証後に破棄）」で、
**再発行ではなく削除**した（検収者が実施）。

**削除しただけでは即座に失効しない。** Vercel の仕様で、
**既存のデプロイは再デプロイされるまで古い値を使い続ける。**
完全に失効するのは次の本番デプロイのときである。

**コード側に参照は無い**（`VERCEL_AUTOMATION_BYPASS_SECRET` /
`x-vercel-protection-bypass` を読む `.ts` / `.tsx` / `.yml` は **0件**・2026-09-08 実測）。
したがって削除で壊れるものは無い。

### 必要になったときの作法

1. **その都度発行し、使い終わったら削除する。** 常設しない
2. **クエリパラメータでは渡さない。`x-vercel-protection-bypass` ヘッダで渡す**

```
$ curl -X POST https://<Preview のドメイン>/api/billing/webhook     -H "x-vercel-protection-bypass: <secret>"     -H "stripe-signature: <署名>"     --data-binary @payload.json
```

3. **この値を本番に流用しない**
4. **保護そのものは落とさない。** Disabled にすると Preview 全体が誰にでも開く

### Stripe の Webhook 送信先には Preview を使わない

**Stripe の Webhook はカスタムヘッダを送れない。** ヘッダで渡せない以上、
**Stripe から Preview へ直接送る経路は作らない**（作るとクエリパラメータに戻る）。
Preview で webhook を確かめるときは、**上の curl のように自分で POST する**か、
本番の webhook を使う。

## 5. 通しで確かめる（Preview 推奨）

1. `/connect` を開き、購読の導線から Stripe の画面へ飛ぶ
2. Stripe の**テストカード**で購読を確定する
3. `/connect?billing=done` に戻る
4. **Supabase の Authentication → Users** でそのユーザーの
   `user_metadata.subscription.status` が `active` になっていることを見る

4 が変わっていなければ webhook が届いていない。Stripe の Webhook ログで
配信の成否と応答コードを見る。**応答コードごとに原因が違う。**

| 応答      | 原因                                                                          |
| --------- | ----------------------------------------------------------------------------- |
| **302**   | **Deployment Protection（SSO）に弾かれている。アプリに届いていない**（手順4） |
| 401       | 署名シークレットの不一致                                                      |
| 4xx / 5xx | アプリ側の処理の失敗                                                          |

> **2026-09-03 訂正。** ここは当初「401 なら署名シークレットの不一致」とだけ書いていた。
> **302 が表に無かったため、届いてすらいない状態を署名の問題と読み違える。**
> スライスBU の実装中に実測で見つかり、契約側（`docs/contracts/slice-billing-ui.md`）も
> 同じ表に訂正済みである。**まず「アプリに届いているか」を見る。**

## 6. 済んだら、こちらに伝えること

`DEFAULT_PLAN` を `TRIAL_PLAN` に倒す作業が残っている（`_shared/budget.ts`）。

**いまは購読が無い会社も標準（10回）である。** 購読という概念が無い間に試用へ倒すと、
**いまいる会社の枠を黙って 10 → 3 に減らす**ことになるためで、
Stripe が回り始め、既存の会社に購読が付いてから倒す。

## 既知の罠

- **`billing_address_collection` と `customer_creation` を渡さない**（CLAUDE.md の絶対規則）。
  サブスクリプションでこの2つを渡すと 500 になることが既知である。コード側では渡していない
- 署名検証は**生の本文**で行う。本文を先にパースして組み直すと必ず不一致になる
