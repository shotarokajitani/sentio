# ADR-0002: 認証境界は `resolveCaller` の一層とする

状態: accepted / 決定日: 2026-08-29（判断材料: `docs/reports/2026-08-29_認証境界は一層である_判断材料.md`）

## 決定

- Edge Function の**唯一の認証境界を `resolveCaller`（`supabase/functions/_shared/caller.ts`・契約 S-2-9）とする**。
  「たまたま一層しかない状態」ではなく、**一層であることを宣言された設計**として扱う
- その保証は `check:caller-guard`（`scripts/check-caller-guard.ts`）に置く。
  デプロイ対象の全 Function が `resolveCaller` を通っていることを CI（`ci.verify`）で機械検査する。
  Function を足して呼び忘れれば CI が赤になる
- **追加の層は置かない。** `--no-verify-jwt` は付けず、`verify_jwt = true` も書かない（現状維持）

## 背景 — この項目が立っていた前提は4つとも崩れた

`07_open_items.md` に 2026-08-20 に登録した「レガシー JWT キーの廃止と、ゲートウェイ JWT 検証の依存
（期限あり・未判断）」は、次の4つの前提の上に立っていた。**2026-08-27〜29 の実測で全部崩れた。**

| # | 2026-08-20 の記述 | 実測（2026-08-27〜29） |
| --- | --- | --- |
| 1 | 17本すべてから `--no-verify-jwt` を外した。これは**ゲートウェイ層での JWT 検証に依存する設計**である | **ゲートウェイは JWT を検証していない。** ヘッダ無し / `Bearer not-a-jwt-at-all` / 署名の壊れた JWT の3通りとも、返ってきたのは `caller.ts` の `unauthorized()`（`{"error":"unauthorized"}`）。**不正な JWT がユーザーワーカーまで届いている** |
| 2 | 本番の service_role キーは `prefix = eyJ` でレガシー形式 | Edge Function の env は **`sb_secret_...`（新形式）**。GitHub Secrets の値だけを差し替えた実験で、レガシーは 401・新形式は 200（`invoke-function` #4/#5 → 401、#6 → 200） |
| 3 | 新形式へ移るとゲートウェイ検証が使えなくなり、**案B が失われる** | **失うものが無い。** 案B は最初から成立していなかった |
| 4 | 着手前に、新形式キーがゲートウェイでどう扱われるかの**実測**が要る | **実測済み**（`invoke-function` #6〜#12 が 2xx） |

**なぜ検証が効いていないか:** `deploy.yml` は素の `supabase functions deploy` を使っており
`--no-verify-jwt` は付けていない。一方 `supabase/config.toml` には `[functions.*]` の節が1つも無い。
フラグを外したのに効かないのではなく、**有効化する側の設定がどこにも存在しない**。

**鍵の移行はすでに完了している**（Edge Function の env / Vault `sentio_service_role_key` /
GitHub Secrets の3箇所とも新形式）。したがって **2026年末の廃止期限に追われる理由は無い**。
「鍵の移行が認証境界を1層まるごと外す」という当時の懸念は、**外れる層が最初から無かった**ため起きなかった。

実測の全文: `docs/reports/2026-08-27_service_role_key形式の実測.md`

## 採らなかった案

- **案B（`resolveCaller` の手前に別のガード関数を置く）**: **二層に見えて一層。**
  同じワーカー・同じデプロイ・同じコードベースで動くので、片方が壊れる状況ではもう片方も壊れる。
  防御の深さは増えず、宣言だけが二層になる
- **案C（別プロセス（プロキシ等）を立てて本当の二層にする）**: 本物の二層になる。
  ただし運用対象が1つ増える。SME向け1人開発というこの規模に対して重い
- **案D（`config.toml` に `[functions.*] verify_jwt = true` を書く）**: **採れない。**
  Supabase 公式が「Edge Functions は `anon` / `service_role` の **JWT ベースのキーでしか**
  JWT 検証が動かない」と明記しており、内部呼び出しは新形式 `sb_secret_...` を使っている。
  有効化すると**内部呼び出しが全部弾かれ**、cron・`invoke-function`・Day0 が止まる

## 保証と、その限界

- **保証**: `check:caller-guard` が「全 Function が `resolveCaller` を通る」ことを CI で担保する。
  `resolveCaller` は fail-closed で、判定できないリクエストには 401 を返す
- **限界（設計上のもの。不具合ではない）**: `resolveCaller` 自身の論理が壊れた場合、
  それを受け止める外側の層は無い。`check:caller-guard` が見るのは**呼んでいるかどうか**であって、
  中身が正しいかではない。中身の担保は `resolveCaller` 自身のユニットテスト（陽性・陰性コントロール）の責任である
- **漏洩は起きていない。** 認証情報の無いリクエストが実データに到達しないことは実測済み

## 再決定の条件

次のいずれかが起きたら、この ADR を見直す。

- **Supabase が新形式キー（`sb_secret_...` / `sb_publishable_...`）でもゲートウェイの JWT 検証を提供したら。**
  そのときは案D が現実的な選択肢に戻る（追加の運用対象なしに本物の二層になるため）
- `resolveCaller` の論理的な欠陥に起因する事故が実際に起きたら（案C を再評価する）
- Sentio の規模が変わり、別プロセスの運用コストが相対的に軽くなったら
