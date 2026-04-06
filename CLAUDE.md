# SENTIO — Claude Code 実装指示書

> このファイルをC:\Users\shota\sentio\CLAUDE.mdとして保存する
> Claude Codeはこのファイルを最初に読んでから作業を開始すること
> 更新日：2026年4月6日

---

## 0. このファイルの使い方

Claude Codeを起動したら、最初に必ずこのファイルを読む。
作業前にセルフチェックリストを確認する。
完了報告は所定のフォーマットで行う。

---

## 1. プロダクト概要

| 項目           | 内容                                                               |
| -------------- | ------------------------------------------------------------------ |
| サービス名     | Sentio（センティオ）                                               |
| コンセプト     | 決断が生まれる組織をデザインする。                                 |
| 本質           | 答えを出すのではなく、問いをデザインする存在                       |
| ターゲット     | 従業員5〜50名・年商5000万〜10億円の経営者                          |
| ビジネスモデル | SaaS月額サブスクリプション                                         |
| 代表者         | 梶谷将太郎（株式会社ディセーノ）                                   |
| 送信メール     | shotaro.kajitani@mdc-diseno.com                                    |
| 会社住所       | 〒150-0043 東京都渋谷区道玄坂１丁目１０−８ 渋谷道玄坂東急ビル 2F-C |

---

## 2. インフラ情報

| サービス             | URL / ID                                  |
| -------------------- | ----------------------------------------- |
| Supabase             | https://kwpldqbnkraftaahnpev.supabase.co  |
| Supabase Project Ref | kwpldqbnkraftaahnpev                      |
| Vercel               | https://vercel.com/diseno1/sentio         |
| 本番URL              | https://www.sentio-ai.jp                  |
| GitHub               | https://github.com/shotarokajitani/sentio |

### Supabase Secrets（登録済み・参照のみ）

```
ANTHROPIC_API_KEY       → 登録済み
GOOGLE_PLACES_API_KEY   → 登録済み
STRIPE_SECRET_KEY       → 登録済み
STRIPE_PRICE_STARTER_MONTHLY → 登録済み
STRIPE_PRICE_STARTER_YEARLY  → 登録済み
STRIPE_PRICE_GROWTH_MONTHLY  → 登録済み
STRIPE_PRICE_GROWTH_YEARLY   → 登録済み
STRIPE_PRICE_SCALE_MONTHLY   → 登録済み
STRIPE_PRICE_SCALE_YEARLY    → 登録済み
RESEND_API_KEY          → 登録済み
SENTRY_DSN              → 登録済み
ENVIRONMENT             → production
```

---

## 3. デザインシステム（必ず守ること）

```
背景色：#f7f5f2（クリーム）※ダーク背景は使わない
アクセントカラー：#0e5070（ミッドオーシャン）※紫は使わない
見出しフォント：Cormorant Garamond
本文フォント：Inter
ロゴ表記：Sentio（"e"のみ#0e5070）※SENTIO全大文字は不可
```

### 参照デザイン（平仄を合わせること）

- Motus：https://www.motus-ai.jp
- Lauda：https://www.lauda-ai.com

---

## 4. DBスキーマ（Supabaseに実行済み・変更禁止）

14テーブルが既に作成済み。スキーマの変更はしない。
参照のみ行うこと。

```
companies, subscriptions, competitors, external_data,
signals, questions, conversations, patterns,
industry_patterns, integrations, usage_logs,
api_keys, click_tokens, error_logs
```

### 重要なフィールド

**questions.status**

```
pending → delivered → answered / skipped / deferred / expired
```

**signals.strength**

```
high（3+データソース重複）/ medium（2ソース）/ low（1ソース）
```

**signals.pattern_id**

```
1: 表と裏の矛盾（URLの言葉 vs 実態）
2: 成長と実態の矛盾（売上 vs 利益・キャッシュ）
3: 戦略と行動の矛盾（採用・投資 vs コスト構造）
4: 過去と現在の矛盾（3年前 vs 現在）
5: 集中と分散の矛盾（取引先依存度）
6: 言葉と感情の矛盾（会話から生まれる・detect-signalsでは検出しない）
7: 内部と外部の交差（競合・市場 vs 自社）
8: 沈黙のシグナル（来るべきものが来ていない）
9: 広告費と売上の矛盾（Meta/GA4/Shopifyの数字の食い違い）
```

**⚠️ パターン6は detect-signals では検出しない。process-answer の中でのみ検出する。**

---

## 5. Edge Functions 実装仕様

### デプロイコマンド

```powershell
npx supabase functions deploy [function名] --no-verify-jwt --project-ref kwpldqbnkraftaahnpev
```

### 関数一覧と実行コンテキスト

```
JWT必須：
  process-answer

JWT不要（--no-verify-jwt）：
  collect-external-data
  suggest-competitors
  detect-signals
  generate-question
  deliver-question
  learn-pattern
  on-concern-changed
  on-integration-connected
  check-trial-expiry
  cleanup-external-data

Stripe関連（--no-verify-jwt）：
  create-checkout
  stripe-webhook
  create-portal-link
```

### \_shared/sentry.ts（全関数に必須）

```typescript
import * as Sentry from "https://deno.land/x/sentry/index.mjs";

const SENTRY_DSN = Deno.env.get("SENTRY_DSN");

export function initSentry(functionName: string) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: Deno.env.get("ENVIRONMENT") || "production",
    release: "sentio@1.0.0",
    integrations: [],
    tracesSampleRate: 0.1,
  });
  Sentry.setTag("function", functionName);
}

export function captureError(
  error: Error,
  context?: {
    company_id?: string;
    extra?: Record<string, unknown>;
  },
) {
  Sentry.withScope((scope) => {
    if (context?.company_id) scope.setUser({ id: context.company_id });
    if (context?.extra) scope.setExtras(context.extra);
    Sentry.captureException(error);
  });
}

export { Sentry };
```

### 各関数の核心ロジック

#### collect-external-data

```typescript
// 入力
{ company_id: string, trigger: 'registration' | 'weekly_batch' | 'manual' }

// 重要ルール
// ① 各ソースを独立してtry-catchで囲む（一つ失敗しても他は続行）
// ② レビューテキストの生データはDBに保存しない（処理後に破棄）
// ③ 同一ドメインへのリクエストは1秒に1回以下
// ④ 完了後にdetect-signalsをトリガー

// 収集するソース
// A. URLスクレイピング（静的HTMLのみ）
// B. Google Places API（GOOGLE_PLACES_API_KEY使用）
// C. 求人情報（Google Jobs API or Indeed RSS）
// D. 登記情報（国税庁法人番号公表サイトAPI）
// E. 業界統計（事前キャッシュ済みデータ）
// F. 競合情報（competitorsテーブルのconfirmed=trueのみ）

// expires_at設定
// googlemap, job_posting: +6ヶ月
// competitor_site: +3ヶ月
// industry_stats, registration: +12ヶ月
```

#### suggest-competitors

```typescript
// Claude APIで競合候補を3〜5社提案
// URLの実在確認（HEAD request）後にcompetitorsテーブルに保存
// confirmed=false（翌日経営者に確認を求める）
// JSON出力: { competitors: [{ name, url, reason }] }
```

#### detect-signals

```typescript
// ⚠️ パターン6は除外してClaude APIに送ること
// ⚠️ 14日以内に配信済みのパターンはスキップ

// Claude APIへの入力
// - 最新のexternal_data
// - 直近20件のconversations
// - 会社プロフィール

// 出力（JSON）
// {
//   pattern_id: 1-9（6を除く）,
//   strength: 'high' | 'medium' | 'low',
//   direction: 'risk' | 'opportunity' | 'silence',
//   source: 'system',
//   description: '一行の説明',
//   evidence: { data_points: [], overlap_count: number },
//   expires_at_days: 14 | 28 | 56
// }

// highシグナル → 即時generate-questionをトリガー
// medium/low → 週次バッチで処理
```

#### generate-question

```typescript
// MAX_RETRY = 3
// 禁止フレーズチェック（3回失敗でフォールバック問いを使用）

// 禁止フレーズ
const PROHIBITED = [
  "検討してください",
  "必要があります",
  "すべきです",
  "してください",
  "重要です",
  "ことをお勧め",
  "べきでしょう",
];

// Claude API出力（JSON）
// {
//   question_text: '150文字以内',
//   question_type: 'normal' | 'sensitive' | 'opportunity',
//   question_rationale: '内部記録用',
//   evidence_summary: '一行',
//   opening_line: '50文字以内',
//   skip_message: 'sensitiveの場合のみ',
//   answer_hints: ['ヒント1', 'ヒント2', 'ヒント3']
// }

// パターン6のフォールバック問い（生成失敗時）
// '今、誰かに話したいけど話せていないことが、何かありますか。'
```

#### deliver-question

```typescript
// delivery_attempts >= 3 → 配信停止・status='expired'
// クリックトークンでリンク追跡（トラッキングピクセルは使わない）

// 件名テンプレート
// high: '今週、確認していただきたいことがあります。'
// medium: '気になることがあります。'
// low: '少し聞いてもいいですか。'

// Resend送信
// from: 'Sentio <hello@sentio-ai.jp>'
// メール本文: opening_line → evidence_summary → question_text → answer/skipリンク
```

#### process-answer

```typescript
// 入力
// { question_id, company_id, action: 'answer' | 'skip' | 'defer', answer_text? }

// ⚠️ 冪等性チェック必須
// answered_at / skipped_at / deferred_at のnullチェックで二重処理防止

// skip → signal.status='resolved', resolution_type='user_reported'
// defer → question.status='deferred'（ホーム画面に保留表示）
// answer → Claude APIで解釈 → 新シグナル検出 → learn-patternトリガー

// パターン6のシグナルはprocess-answerの中で検出
// source='executive' でsignalsテーブルに挿入
```

#### learn-pattern

```typescript
// patternsテーブルに記録
// allow_industry_analysis=true のときのみ industry_patterns にも匿名記録
// MVPでは記録のみ（50社以上になってから学習ロジックを起動）
```

#### check-trial-expiry（pg_cronで毎日午前9時実行）

```typescript
// 4段階処理
// ① Trial終了3日前リマインドメール
// ② Trial終了1日前リマインドメール
// ③ Trial終了 → status='trial_expired' / pending questionsをexpiredに
// ④ Trial終了から7日後 → status='canceled' / scheduled_deletion_at=now()+180days
```

#### on-concern-changed（Database Webhookからトリガー）

```typescript
// initial_concern変更時の処理
// ① pending状態のquestionsを全て削除
// ② detect-signalsを再実行
```

#### on-integration-connected（Database Webhookからトリガー）

```typescript
// 会計ソフト連携完了 → onboarding_stage='stage2'
// カレンダー連携完了 → onboarding_stage='stage3'
// 完了後にdetect-signalsを再実行
// 連携完了通知メールを送信
```

#### create-checkout

```typescript
// ⚠️ 絶対に追加しないこと
// billing_address_collection → 500エラーの原因（Laudaで確認済み）
// customer_creation → サブスクモードで競合発生

const session = await stripe.checkout.sessions.create({
  payment_method_types: ["card"],
  mode: "subscription",
  line_items: [{ price: PRICE_IDS[plan], quantity: 1 }],
  success_url: `${origin}/app.html?checkout=success`,
  cancel_url: `${origin}/app.html?checkout=cancel`,
  metadata: { userId, plan },
  locale: "ja",
  // billing_address_collection: 絶対に追加しない
  // customer_creation: 絶対に追加しない
});
```

#### stripe-webhook

```typescript
// 処理するイベント
// checkout.session.completed → subscriptions更新
// customer.subscription.deleted → status='canceled'
// customer.subscription.updated → プラン変更処理
```

---

## 6. トライアル機能（完全実装）

```typescript
// generate-questionの冒頭に追加
const TRIAL_QUESTION_LIMIT = 10;

if (subscription.status === "trialing") {
  const count = await getTrialQuestionCount(company_id);
  if (count >= TRIAL_QUESTION_LIMIT) {
    await sendTrialLimitReachedEmail(company_id);
    return { success: false, reason: "trial_limit_reached" };
  }
}
```

### app.htmlのトライアルバナー（ホーム画面上部）

```html
<!-- status === 'trialing' の場合のみ表示 -->
<div class="trial-banner">
  トライアル期間 残り<strong>{{days_remaining}}</strong>日 ·
  問い<strong>{{questions_remaining}}</strong>回分
  <a href="#plan">プランを選ぶ</a>
</div>
```

---

## 7. 料金プラン

| プラン  | 月額       | 年額     |
| ------- | ---------- | -------- |
| Trial   | 14日間無料 | —        |
| Starter | ¥9,800     | ¥98,000  |
| Growth  | ¥29,800    | ¥298,000 |
| Scale   | ¥79,800    | ¥798,000 |

---

## 8. メールテンプレート

### 送信元

```
from: 'Sentio <hello@sentio-ai.jp>'
```

### 件名パターン

```
最初の問い（high）: 今週、確認していただきたいことがあります。
最初の問い（medium）: 気になることがあります。
最初の問い（low）: 少し聞いてもいいですか。
Trial終了3日前: Sentioのトライアルが3日後に終了します
Trial終了: Sentioのトライアルが終了しました
Trial上限到達: Sentioの問いが上限に達しました
連携完了: {{integration_name}}の連携が完了しました
週次サマリー: 今週のSentio（{{month}}第{{week}}週）
```

---

## 9. app.html 画面構成

### タブ構成

```
① ホーム（デフォルト）
   - トライアルバナー（trialing時のみ）
   - 最新の問いカード（answered/skip/defer ボタン付き）
   - Sentioが最後に確認したこと
   - データの接続状況

② 会話
   - チャット形式で問いと答えが積み上がる
   - 答える入力欄（底部固定）
   - answer/skip/deferの3ボタン
   - answer_hintsをヒントとして表示

③ シグナル
   - strength別（high/medium/low）一覧
   - 解決済みはデフォルト非表示
   - resolution_typeの表示

④ 設定
   - 会社情報タブ
   - データ連携タブ
   - 競合管理タブ

⑤ プラン
   - 現在のプランと利用状況
   - アップグレード促進
   - Stripeカスタマーポータルへのリンク
```

### オンボーディング（初回ログイン時）

```
Step 1: 会社名とURL入力
  → 「決算書は後からで大丈夫です」という一言を添える

Step 2: 今一番気になっていること（6択・タップ一つで次へ）
  もっと伸ばしたいことがある
  止めたいことがある
  始めたいことがある
  守りたいことがある
  決めなければいけないことがある
  誰かに話したいことがある

Step 3（翌日）: 競合確認
  → Sentioが提案した競合候補を表示
  → 翌日の最初の問いと一緒に届ける

完了画面:
  「Sentioが御社のことを調べ始めました」
  「明日、最初の問いをお届けします」
  freee/マネーフォワード連携のインセンティブを提示
```

---

## 10. index.html（LP）構成

```
Section 1: ヒーロー
  キャッチコピー：「決断が生まれる組織をデザインする。」
  ターゲット明示：「従業員5名〜50名の経営者へ。」
  サブコピー：
    「会議が終わった。でも、何も決まらなかった。
     数字は見た。でも、動く理由が見つからない。
     感じていることはある。でも、誰にも話せない。
     Sentioは、その「なんとなく」を読んで、
     今週動くべき一つの問いを届けます。」
  CTAボタン：「まず、会社名とURLだけで試してみる」

Section 2: 共感
  経営者が深夜に感じていることを言語化

Section 3: Sentioが何をするか（3ステップ）
  Step 1: 御社のことを知る
  Step 2: 気になることを届ける
  Step 3: 会話が積み上がる

Section 4: 競合比較表
  ChatGPT / BIツール / Sentio の3列比較

Section 5: デモカード
  業種選択でサンプル問いが切り替わる（JS静的実装）

Section 6: 料金プラン

Section 7: よくある不安への答え
  「決算書を入れることが怖い」
  「AIが経営判断に使えるのか」
  「税理士や顧問と何が違うのか」
  「いつでも解約できますか」

Section 8: CTA（最終）
  「まず、14日間試してみてください。」
  CTAボタン：「まず、会社名とURLだけで試してみる」
```

---

## 11. pg_cronジョブ（Supabaseに設定済み）

```sql
-- 以下は既に設定済み。再実行しないこと。
weekly-collect-batch  → 月曜深夜0時
weekly-detect-batch   → 月曜午前4時
weekly-generate-batch → 月曜午前6時
weekly-deliver-batch  → 月曜午前8時
daily-trial-check     → 毎日午前9時
monthly-cleanup       → 毎月1日午前3時
weekly-summary-email  → 毎週日曜午後6時
daily-expire-questions → 毎日深夜1時
daily-expire-signals  → 毎日深夜1時
monthly-delete-expired → 毎月1日午前2時
```

---

## 12. デプロイ後に手動で設定するもの（Claude Codeでは不要）

```
① Supabase Database Webhooks（3つ）
   companies INSERT → collect-external-data
   companies UPDATE → on-concern-changed
   integrations UPDATE → on-integration-connected

② Stripe Webhook設定
   checkout.session.completed
   customer.subscription.deleted
   customer.subscription.updated
   → STRIPE_WEBHOOK_SECRETをSupabase Secretsに登録
```

---

## 13. 実装上の禁止事項

```
❌ Stripeでbilling_address_collectionを使う → 500エラー
❌ Stripeでcustomer_creationを使う → サブスクモードで競合
❌ Vercelでpublic/フォルダを作る → rootのHTMLが404になる
❌ Google OAuth callback URLにurl.originを使う → 環境によって変わる
❌ Edge Functionをデプロイするとき--no-verify-jwtを付け忘れる
❌ パターン6をdetect-signalsで検出しようとする
❌ 禁止フレーズを問いのテキストに使う
```

---

## 14. 完了報告フォーマット

```
完了後、以下のフォーマットで報告してください：
✅ 実装ファイル：（ファイル名・関数名）
✅ デプロイ：（完了 / 未実施）
✅ 確認URL：（該当URL）
✅ セルフチェック：（確認事項と結果）
⚠️ 注意事項：（あれば）
```

---

## 15. 実装フェーズ

### フェーズ1（今すぐ）

```
① _shared/sentry.ts の作成
② create-checkout の実装・デプロイ
③ stripe-webhook の実装・デプロイ
④ create-portal-link の実装・デプロイ
⑤ index.html（LP）の全面書き直し
⑥ app.html（ダッシュボード）の全面書き直し
⑦ git push → Vercelへ自動デプロイ
⑧ 動作確認
```

### フェーズ2（フェーズ1完了後）

```
① collect-external-data の実装・デプロイ
② suggest-competitors の実装・デプロイ
③ detect-signals の実装・デプロイ
④ generate-question の実装・デプロイ
⑤ deliver-question の実装・デプロイ
⑥ process-answer の実装・デプロイ
⑦ learn-pattern の実装・デプロイ
⑧ on-concern-changed の実装・デプロイ
⑨ on-integration-connected の実装・デプロイ
⑩ check-trial-expiry の実装・デプロイ
```

### フェーズ2完了後（手動）

```
① Database Webhookの設定（Supabaseダッシュボード）
② Stripe Webhookの設定（Stripeダッシュボード）
③ エンドツーエンドテスト
```

---

_Sentio | 株式会社ディセーノ | 2026年4月6日_
