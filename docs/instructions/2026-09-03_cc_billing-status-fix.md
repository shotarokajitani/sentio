# CC への指示 — 購読の status が永久に `active` にならないのを直す（2026-09-03）

- 種別: バグ修正（契約 スライスBU の範囲内。新しい契約は立てない）
- 対象 PR: **#84 に追加コミットする**（まだ merge していない）
- 起草: 検収者（本番 Preview での実測に基づく）

## 何が起きているか（**実測・2026-09-02 19:05 UTC**）

Preview で購読を1回通した。**webhook は 200 を返し、書き込みも成功している。**

```
19:05:18  POST /api/billing/checkout  200
19:05:44  POST /api/billing/webhook   200
19:05:55  GET  /connect               200
```

そのとき `auth.users.raw_user_meta_data` に書かれた値（本番 Supabase・実物）:

```json
"subscription": {
  "status": "complete",
  "plan_id": "standard",
  "stripe_customer_id": "cus_…",
  "stripe_subscription_id": "sub_…"
}
"updated_at": "2026-09-02 19:05:45.644148+00"
```

**`status` が `"complete"` である。`"active"` ではない。**

## なぜそうなるか

`src/app/api/billing/webhook/route.ts:67-71`

```ts
const status =
  event.type === "customer.subscription.deleted"
    ? "canceled"
    : typeof object.status === "string"
      ? object.status // ← ここ
      : "active";
```

**`checkout.session.completed` の `data.object` は Checkout Session である。**
Checkout Session の `status` は `open` / `complete` / `expired` の3値で、
**購読の状態ではない。** 決済が完了すれば必ず `"complete"` が入る。

## 影響（**待っても直らない**）

```
src/app/connect/connect-client.tsx:277   subscribed = subscriptionStatus === "active"
src/lib/billing/plan.ts:37               ENTITLED_STATUSES = new Set(["active", "trialing"])
```

**どちらも `"complete"` を通さない。**
払っても購読ボタンが消えず、枠も増えない。**時間の問題ではない。**

**他のイベントでは救えない。** `customer.subscription.updated` / `.deleted` の
`data.object` は Subscription であり、**`client_reference_id` を持たない**（`route.ts:55`）。
会社を引けず `{"status":"ignored","reason":"no_company"}` を返して終わる。
**書き込めるイベントは実質 `checkout.session.completed` の1本だけである。**

## テストが緑だった理由（**ここも直す。直さないと同じことが起きる**）

`tests/unit/billing-webhook.test.ts:42-52` の `PAYLOAD` はこうなっている。

```ts
const PAYLOAD = JSON.stringify({
  type: "checkout.session.completed",
  data: { object: { client_reference_id: COMPANY, …, status: "active" } },
});
```

**Checkout Session に `status: "active"` は入らない。**
フィクスチャが**実装に合わせて書かれており、実物に合わせて書かれていなかった。**
だから `expect(...status).toBe("active")` が緑のまま、本番で `"complete"` が書かれた。

**実装だけ直してフィクスチャを残すと、テストは嘘をつき続ける。** 両方直すこと。

## 決定（**この範囲だけ。広げない**）

| #         | 論点                                | 決定                                                                                                                                                                                  |
| --------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BS-D1** | `object.status` の扱い              | **無条件に信用しない。イベントの種類で分岐する。** Checkout Session と Subscription は別の型であり、同じ `status` という名前でも意味が違う                                            |
| **BS-D2** | `checkout.session.completed` のとき | **`"active"` を書く。** ただし `payment_status` が `"paid"` でない場合は書かない（`no_company` と同じく 200 で無視する）。決済が済んでいないセッションで購読中にしない                |
| **BS-D3** | `customer.subscription.*` のとき    | **`object.status` をそのまま使う**（Subscription の `status` は購読の状態そのもの）。`deleted` は従来どおり `"canceled"` に倒す。**会社が引けないので現状は到達しないが、分岐は残す** |
| **BS-D4** | Stripe API を呼ぶか                 | **呼ばない**（BU-D2）。webhook の本文だけで決める                                                                                                                                     |
| **BS-D5** | `"complete"` が既に書かれている会社 | **コードで移行しない。** 実データは Preview のサンドボックスの1件だけで、外部顧客は居ない。**移行スクリプトを書かない**                                                               |

## 受入基準

### BS-1 系: 正しい status を書く

| #      | 基準                                                                                                                                                           | 検証                                                         |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| BS-1-1 | `checkout.session.completed` かつ `payment_status: "paid"` のとき **`status: "active"` を書く**                                                                | unit                                                         |
| BS-1-2 | **`data.object.status` が `"complete"` でも、書かれる値は `"active"` である**                                                                                  | unit（**今回の本体**）                                       |
| BS-1-3 | `checkout.session.completed` で `payment_status` が `"unpaid"` / `"no_payment_required"` 以外の未払い値のとき、**`updateUserById` を呼ばない**。200 で無視する | unit（**陰性コントロール。払っていない人を購読中にしない**） |
| BS-1-4 | `customer.subscription.updated` で `status: "past_due"` のとき、**`"past_due"` がそのまま書かれる**（`"active"` に潰さない）                                   | unit（**陰性コントロール**）                                 |
| BS-1-5 | `customer.subscription.deleted` は従来どおり `"canceled"`                                                                                                      | 既存テストが通ること                                         |

### BS-2 系: フィクスチャを実物に合わせる

| #      | 基準                                                                                                                     | 検証                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| BS-2-1 | `tests/unit/billing-webhook.test.ts` の Checkout Session フィクスチャが **`status: "complete"` を持つ**（実物と同じ形）  | 目視＋diff                                             |
| BS-2-2 | Checkout Session のフィクスチャに **`payment_status` を持たせる**（実物にある。無いと BS-1-3 が書けない）                | 目視                                                   |
| BS-2-3 | Subscription 側のフィクスチャは **`client_reference_id` を持たない**形も1つ置き、`no_company` で無視されることを固定する | unit（**実物どおり。持っている前提の試験を残さない**） |

### BS-3 系: 壊してはいけないもの

| #      | 基準                                                                                                              | 検証                               |
| ------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| BS-3-1 | 署名検証の経路と 401 の挙動が**1文字も変わらない**                                                                | 既存テストが通ること               |
| BS-3-2 | 保存するキーが4つのまま（`plan_id` / `status` / `stripe_customer_id` / `stripe_subscription_id`）。**増やさない** | 既存テスト（`:129-140`）が通ること |
| BS-3-3 | 会社を引けない通知を 200 で受ける挙動を変えない（再送を滞留させない）                                             | 既存テストが通ること               |
| BS-3-4 | `/connect` の画面コードと `plan.ts` を**触らない**。直すのは webhook 側だけ                                       | git diff                           |

## 停止点

- **merge しない。** PR #84 に追加コミットして全緑にした時点で止まり、報告する
- **`connect-client.tsx` と `plan.ts` を触らない。** `"complete"` を通す側に足して辻褄を合わせない。
  **`"complete"` は購読の状態ではないので、通す方が誤りである**
- **既存データの移行を書かない**（BS-D5）
- **`trialing` の扱いを決めない**（`07_open_items.md` の未判断項目。今回は触らない）
- 本番 Ref `kwpldqbnkraftaahnpev` への CLI 直接操作をしない

## `07_open_items.md` の更新（**閉じない。射程を縮める**）

「`?billing=done` で戻った直後、まだ『試用中』に見える」の項に追記すること。

- **原因の一部が判明した**（2026-09-03 実測）。webhook の到着待ちだけではなく、
  **到着しても `status` が `"complete"` で、永久に購読中にならなかった**
- **この修正でその部分は消える**。残るのは本来の論点である
  「webhook が着くまでの数秒をどう見せるか」だけになる
- **項目は閉じない。** 3つ目の状態を置くかの判断（(a)/(b)）はそのまま残る

## この修正が終わったら分かること

**払った人が、払ったとおりに見えるかどうか。**

署名シークレットが正しいことは実測で確かめた（webhook 200・書き込み成功）。
**残っていたのは「何を書くか」だった。** 経路は通ったのに中身が違う、
という形は `06` の Scanner ラベリングと同じで、**通ったことと正しいことは別である。**
