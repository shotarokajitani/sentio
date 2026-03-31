# SENTIO — プロジェクト指示書

> このファイルをclaude.aiの「SENTIO」プロジェクトに設置する。
> LP設計・アプリ実装・AI設計・エコシステム連携の議論はすべてこのプロジェクトで行う。
> **更新日：2026年3月31日**

---

## 1. プロダクト概要

| 項目                       | 内容                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| **サービス名**             | SENTIO（センティオ）                                                                     |
| **ラテン語の意味**         | 感じる・知覚する・判断する                                                               |
| **コンセプト**             | データを「so what」に変える、中小企業向けAI経営判断エンジン                              |
| **ブランドフィロソフィー** | "Not more data. The right decision."                                                     |
| **日本語タグライン**       | データが多すぎる。判断が足りない。                                                       |
| **ポジショニング**         | BIツールではなく「翻訳者」。数字を集めるのではなく、この会社の文脈で解釈して判断に変える |
| **ビジネスモデル**         | SaaS月額サブスクリプション（3プラン）                                                    |
| **代表者**                 | 梶谷将太郎（株式会社ディセーノ）                                                         |
| **送信メール**             | shotaro.kajitani@mdc-diseno.com（Google Workspace）                                      |
| **会社住所**               | 〒150-0043 東京都渋谷区道玄坂１丁目１０−８ 渋谷道玄坂東急ビル 2F-C                       |

---

## 2. プロダクト哲学（最重要）

### Sentioの本質的役割

```
❌ Sentioがやらないこと
  → データを集めて並べるだけ（それはBIツールの仕事）
  → グラフを綺麗に描く（Tableauではない）
  → 「先月比+12%でした」という事実の報告

✅ Sentioがやること
  → 「なぜ+12%なのか」「だから何をすべきか」を答える
  → 複数のデータを掛け合わせて見えなかったチャンスを発見する
  → 「今週やるべき3つ」を具体的なアクションとして出す
  → 「放置するとこうなる」というリスクを先に警告する
```

### so what の品質基準

```
✅ 良いso what
  → 「台湾のコスメ売上が+40%。Laudaの口コミに『種類が少ない』が急増。
     今月中に2ブランド追加交渉してください。タイミングは今です。」

❌ ダメなso what
  → 「台湾市場が好調です。さらなる展開を検討してみてください。」
  → 抽象的・当事者でない発言・行動が見えない
```

### デザイン思想

- **シンプル・高密度**：情報は多く、見た目はすっきり
- **意思決定者の時間を奪わない**：ダッシュボードを開いた3秒で「今週やること」がわかる
- **信頼感のある暗さ**：Bloomberg端末・金融系UIの落ち着き。派手な色は使わない
- **参照カラー**：ダークバック（#0f0f13）+ パープル（#7c3aed）+ エメラルド（#34d399）

---

## 3. 料金プラン

| プラン      | 月額    | 分析回数/月 | PDF出力 | API連携（v1.5〜） |
| ----------- | ------- | ----------- | ------- | ----------------- |
| **Starter** | ¥9,800  | 10回        | 5件     | ✗                 |
| **Growth**  | ¥29,800 | 50回        | 無制限  | ✗                 |
| **Scale**   | ¥79,800 | 無制限      | 無制限  | ✅                |

Stripe Price ID は実装時に本番モードで発行し Supabase Secrets に登録する。

```javascript
// create-checkout Edge Functionで使用するPrice IDの定義例
const PRICE_IDS = {
  starter: "price_xxx", // ¥9,800
  growth: "price_xxx", // ¥29,800
  scale: "price_xxx", // ¥79,800
};
```

---

## 4. インフラ情報

| サービス           | URL / ID                                  | 状態        |
| ------------------ | ----------------------------------------- | ----------- |
| **本番LP**         | https://www.sentio-ai.jp                  | ❌ 未構築   |
| **ダッシュボード** | https://www.sentio-ai.jp/app.html         | ❌ 未構築   |
| **GitHub**         | https://github.com/shotarokajitani/sentio | ❌ 未作成   |
| **Vercel**         | vercel.com/diseno1/sentio                 | ❌ 未作成   |
| **Supabase**       | 未作成（東京リージョン指定）              | ❌ 未作成   |
| **Stripe**         | 本番モード（Price ID未発行）              | ❌ 未作成   |
| **ドメイン**       | sentio-ai.jp（要取得確認）                | ❓ 確認必要 |

> **注意**：インフラ構築時は Supabase プロジェクトを東京リージョン（ap-northeast-1）で作成すること。

---

## 5. 画面構成（MVP 6画面）

```
index.html（LP）
  → コンセプト訴求・3プラン料金表・CTAボタン
  → Sentioが解くべき問題（データ過多・判断不足）を視覚的に伝える

app.html（シングルページ・タブ切替）
  ├── ダッシュボード（デフォルト表示）
  │     → 「今週の3つ」カード
  │     → 最新so whatサマリー
  │     → 未実行アクション数バッジ
  │
  ├── 分析を依頼 ← ★ MVP最重要コア機能
  │     → テキスト入力エリア（データ・数値を貼り付け）
  │     → PDF添付エリア（将来実装。MVPはテキストのみ）
  │     → 「so whatを生成する」ボタン
  │     → 生成結果表示（so what + アクションリスト）
  │     → 「実行済み」マークボタン
  │
  ├── インサイト一覧
  │     → 過去の分析セッション一覧
  │     → 実行率（アクション実行済み割合）
  │
  ├── レポート
  │     → 月次サマリーPDF生成ボタン
  │     → 送付先メール設定
  │     → 送付履歴
  │
  └── 設定
        → 会社情報（社名・業種・担当者名）
        → APIキー発行・管理（v1.5用の仕込み）
        → 連携サービス状態（v1.5用の仕込み）
        → Stripeプラン・カスタマーポータル
```

---

## 6. DBスキーマ（Supabase PostgreSQL）

```sql
-- ============================================================
-- companies : ユーザーに紐づく会社情報
-- ============================================================
CREATE TABLE companies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_name  text NOT NULL,
  industry      text,
  context_note  text,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own company" ON companies
  USING (user_id = auth.uid());

-- ============================================================
-- analysis_sessions : 分析セッション（コアテーブル）
-- ============================================================
CREATE TABLE analysis_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  input_type    text NOT NULL DEFAULT 'text',
  input_data    text NOT NULL,
  so_what       text,
  actions       jsonb,
  risk_alerts   jsonb,
  token_used    integer,
  status        text NOT NULL DEFAULT 'processing',
  created_at    timestamptz DEFAULT now()
);
ALTER TABLE analysis_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own sessions" ON analysis_sessions
  USING (company_id IN (SELECT id FROM companies WHERE user_id = auth.uid()));

-- ============================================================
-- action_items : アクションアイテム（実行管理）
-- ============================================================
CREATE TABLE action_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES analysis_sessions(id) ON DELETE CASCADE,
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  priority      integer NOT NULL DEFAULT 1,
  action        text NOT NULL,
  reason        text,
  deadline      text,
  executed      boolean DEFAULT false,
  executed_at   timestamptz,
  effect_note   text,
  created_at    timestamptz DEFAULT now()
);
ALTER TABLE action_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own items" ON action_items
  USING (company_id IN (SELECT id FROM companies WHERE user_id = auth.uid()));

-- ============================================================
-- usage_logs : 月次利用量管理
-- ============================================================
CREATE TABLE usage_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  month           text NOT NULL,
  analysis_count  integer DEFAULT 0,
  UNIQUE(company_id, month)
);
ALTER TABLE usage_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own usage" ON usage_logs
  USING (company_id IN (SELECT id FROM companies WHERE user_id = auth.uid()));

-- ============================================================
-- subscriptions : Stripe サブスクリプション管理
-- ============================================================
CREATE TABLE subscriptions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  stripe_customer_id       text,
  stripe_subscription_id   text,
  plan                     text NOT NULL DEFAULT 'starter',
  status                   text NOT NULL DEFAULT 'trialing',
  current_period_end       timestamptz,
  created_at               timestamptz DEFAULT now(),
  updated_at               timestamptz DEFAULT now()
);
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own subscription" ON subscriptions
  USING (company_id IN (SELECT id FROM companies WHERE user_id = auth.uid()));

-- ============================================================
-- api_keys : エコシステム連携用APIキー（v1.5仕込み）
-- ============================================================
CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key_hash      text NOT NULL UNIQUE,
  label         text,
  last_used_at  timestamptz,
  created_at    timestamptz DEFAULT now()
);
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own keys" ON api_keys
  USING (company_id IN (SELECT id FROM companies WHERE user_id = auth.uid()));
```

---

## 7. Edge Functions 一覧

| Function名           | 役割                                                        | 備考                                                                 |
| -------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| `generate-so-what`   | コア。入力テキスト→Claude API→so what＋アクションリスト生成 | JWT必須                                                              |
| `create-checkout`    | Stripe Checkout Session作成                                 | **注意：billing_address_collection・customer_creation は指定しない** |
| `stripe-webhook`     | checkout.session.completed / subscription.deleted 処理      | JWT不要                                                              |
| `create-portal-link` | Stripeカスタマーポータル URL生成                            | JWT必須                                                              |
| `generate-report`    | 月次PDFレポート生成                                         | JWT必須                                                              |
| `send-report`        | Resend経由でPDF送付                                         | JWT必須                                                              |

### generate-so-what のプロンプト設計（コア）

```typescript
const systemPrompt = `
あなたはSentio、中小企業の経営判断を支援するAIアナリストです。

【役割】
データや報告書を受け取り、「so what（だから何をすべきか）」を経営者に伝える翻訳者です。
BIツールのように数字を並べるのではなく、この会社の文脈で解釈して具体的な行動に変えます。

【会社コンテキスト】
${companyContext}

【出力フォーマット（JSON）】
{
  "so_what": "3〜5文の核心メッセージ。何が起きていて・なぜ重要で・今すぐ何をすべきか",
  "actions": [
    {
      "priority": 1,
      "action": "具体的なアクション（動詞から始める）",
      "reason": "なぜこのアクションが必要か（データの根拠）",
      "deadline": "今週中 / 今月中 / 来月まで 等"
    }
  ],
  "risk_alerts": [
    {
      "level": "high | medium | low",
      "message": "放置した場合のリスク"
    }
  ]
}

【品質基準】
- so_whatは抽象論禁止。「検討してください」「重要です」は使わない
- actionsは必ず動詞から始め・期限を入れ・3つ以内に絞る
- データに基づかない推測は「（推測）」と明記する
- JSON以外は一切出力しない
`;
```

---

## 8. Stripe 実装ルール（横断適用）

> ⚠️ **開発ナレッジ（2026年3月30日 Laudaで発生・全プロジェクト横断適用）**
>
> Stripe の `mode: 'subscription'` では以下パラメータを**絶対に指定しない**：
>
> - `billing_address_collection: 'required'` → 500エラーの原因
> - `customer_creation: 'always'` → サブスクモードでは自動作成されるため競合

```typescript
// ✅ 正しい実装
const session = await stripe.checkout.sessions.create({
  payment_method_types: ["card"],
  mode: "subscription",
  line_items: [{ price: PRICE_IDS[plan], quantity: 1 }],
  success_url: `${origin}/app.html?checkout=success`,
  cancel_url: `${origin}/app.html?checkout=cancel`,
  metadata: { userId, plan },
  locale: "ja",
});
```

---

## 9. エコシステム連携要件（Sentio側）

参照ファイル：`Motus_Lauda_Pagus_Sentio_連携要件.md`

### MVPで準備すること

- `api_keys` テーブルの仕込み ✅ DBスキーマに含む
- Webhook受信エンドポイントのURL予約のみ

### v1.5（Sentio MRR 100万円〜）：Sentioが取得するAPI

```
GET {motus_url}/api/v1/performance
GET {motus_url}/api/v1/plan-execution
GET {lauda_url}/api/v1/weekly-summary
GET {lauda_url}/api/v1/alerts
GET {pagus_url}/api/v1/sales-summary
GET {pagus_url}/api/v1/brand-pipeline
```

### v1.5：SentioがWebhookを受け取る

```
POST /webhook/motus-milestone
POST /webhook/lauda-alert
POST /webhook/pagus-signal
```

### v2.0（Sentio MRR 300万円・100社〜）：Sentioが各サービスに注入する

```
POST {motus_url}/api/v1/strategy-input
POST {lauda_url}/api/v1/priority-tasks
POST {pagus_url}/api/v1/sourcing-priority
```

---

## 10. Claude Code 定型指示書

### 起動コマンド

```powershell
cd C:\Users\shota\sentio
claude
```

### TEMPLATE 1｜プロジェクト初期セットアップ

```
CLAUDE.mdを読み込んで作業を開始してください。

【依頼】Sentioプロジェクトの初期セットアップをしてください。

手順：
1. GitHub リポジトリ shotarokajitani/sentio を初期化
2. index.html / app.html / styles.css の空ファイルを作成
3. Supabase プロジェクトを東京リージョンで作成（プロジェクト名: sentio）
4. DBスキーマ（SENTIO_ProjectContext.md のセクション6）を全テーブル実行
5. Vercel に接続・デプロイ設定
6. sentio-ai.jp ドメインの DNS 設定

完了報告フォーマットで報告してください。
```

### TEMPLATE 2｜LP（index.html）作成

```
CLAUDE.mdを読み込んで作業を開始してください。

【依頼】Sentioのランディングページ（index.html）を作成してください。

デザイン方針：
- カラー：背景 #0f0f13・アクセント #7c3aed（パープル）・成功 #34d399（エメラルド）
- フォント：Cormorant Garamond（見出し）+ Inter（本文）
- トーン：Bloomberg端末・金融系UIの落ち着き。派手さは不要
- コンセプト：「データが多すぎる。判断が足りない。」を視覚的に伝える

必須セクション：
1. ヒーロー：キャッチコピー + so whatのデモ表示（静的）
2. 課題提示：「こんな悩みはありませんか？」（データ過多・判断できない）
3. 解決策：Sentioの3ステップ（入力→分析→アクション）
4. 料金プラン：Starter¥9,800 / Growth¥29,800 / Scale¥79,800
5. CTA：「無料で試す」ボタン → app.html#register
6. フッター：© 株式会社ディセーノ | Diseno リンク

参照デザイン（平仄を合わせる）：
- Lauda：www.lauda-ai.com
- Motus：www.motus-ai.jp

完了報告フォーマットで報告してください。
```

### TEMPLATE 3｜app.html 作成

```
CLAUDE.mdを読み込んで作業を開始してください。

【依頼】Sentioのダッシュボード（app.html）を作成してください。

画面構成（タブ切替・シングルページ）：
1. ダッシュボード：「今週の3つ」カード・最新so whatサマリー・未実行件数
2. 分析を依頼（★コア）：テキスト入力→so what生成→アクション表示
3. インサイト一覧：過去セッション履歴・実行率表示
4. レポート：月次PDF生成・Resend送付
5. 設定：会社情報・APIキー発行・Stripeプラン管理

技術要件：
- Supabase Auth（メール/パスワード）
- generate-so-what Edge Function との接続
- ローディング状態・エラー状態の適切な表示

デザイン：index.html と同一カラー・フォント体系

完了報告フォーマットで報告してください。
```

### TEMPLATE 4｜generate-so-what Edge Function 作成

```
CLAUDE.mdを読み込んで作業を開始してください。

【依頼】Sentioのコア機能 generate-so-what Edge Function を作成してください。

処理フロー：
1. リクエスト受信（input_data テキスト + company_id）
2. companies テーブルから context_note を取得
3. Claude API（claude-sonnet-4-20250514）へプロンプト送信
4. レスポンスJSONをパース（so_what・actions・risk_alerts）
5. analysis_sessions テーブルに保存
6. action_items テーブルに各アクションを保存
7. usage_logs の analysis_count をインクリメント
8. プラン制限チェック（Starter:10回/月・Growth:50回/月）

プロンプト：SENTIO_ProjectContext.md のセクション7を使用

Supabase Secrets に登録が必要なもの：
- ANTHROPIC_API_KEY

完了報告フォーマットで報告してください。
```

### TEMPLATE 5｜Stripe 決済フロー実装

```
CLAUDE.mdを読み込んで作業を開始してください。

【依頼】Stripe 決済フロー（create-checkout・stripe-webhook・create-portal-link）を実装してください。

⚠️ 重要：以下パラメータは絶対に追加しない（サブスクモードで500エラーが発生する）
  - billing_address_collection
  - customer_creation

実装内容：
1. create-checkout Edge Function（3プラン対応）
2. stripe-webhook Edge Function
   - checkout.session.completed → subscriptions テーブル更新
   - customer.subscription.deleted → status を 'canceled' に更新
3. create-portal-link Edge Function

Supabase Secrets に登録が必要なもの：
- STRIPE_SECRET_KEY
- STRIPE_WEBHOOK_SECRET
- STRIPE_PRICE_STARTER
- STRIPE_PRICE_GROWTH
- STRIPE_PRICE_SCALE

完了報告フォーマットで報告してください。
```

### 共通｜完了報告フォーマット

```
完了後、以下のフォーマットで報告してください：
✅ バックアップ：.bakファイル作成済み（該当する場合）
✅ 修正ファイル：（ファイル名）
✅ 確認URL：（該当URL）
✅ セルフチェック：（確認事項と結果）
```

---

## 11. 開発フェーズ・チェックリスト

### MVP（今すぐ着手）

```
□ SENTIO_ProjectContext.md 作成 ✅ 完了
□ GitHubリポジトリ作成
□ Supabaseプロジェクト作成（東京リージョン）
□ DBスキーマ実行（セクション6）
□ index.html（LP）作成
□ app.html（ダッシュボード）作成
□ generate-so-what Edge Function 実装
□ Stripe 3プラン設定・決済フロー実装
□ Vercel デプロイ
□ sentio-ai.jp ドメイン設定
□ エンドツーエンドテスト
□ ユーザー獲得開始
```

### v1.5（Sentio MRR 100万円到達後）

```
□ Lauda → Sentio API取得（週次サマリー）
□ Motus → Sentio API取得（月次パフォーマンス）
□ Pagus → Sentio API取得（月次売上サマリー）
□ Webhook受信エンドポイント実装
□ ダッシュボードに連携データ表示
□ Scale プランでAPI連携機能を開放
```

### v2.0（Sentio MRR 300万円・100社到達後）

```
□ Sentio → 各サービスへの判断注入API
□ 複合インサイト自動生成（4サービス統合）
□ エコシステムビュー（4サービスKPI一覧）
□ フィードバックループ（実行率→精度改善）
□ 業界横断の勝ちパターンDB統合
```

### v3.0（売却検討フェーズ）

```
□ 判断→実行→成果の縦断分析
□ エコシステム全体ROI可視化
□ Shopify・Salesforce・freee 連携拡張
□ データ資産の外部評価用レポート自動生成
```

---

## 12. セキュリティ方針

```
① 会社間のデータ分離：全テーブルにRLS（Row Level Security）適用
② API認証：エコシステム連携はJWT + APIキー（SHA-256ハッシュ保存）
③ Claude APIへ送信するデータは会社コンテキストのみ。他社データとの混在なし
④ 業界横断パターンDB生成時は個社特定情報を削除（v2.0）
⑤ ユーザー解約後180日でデータ完全削除
⑥ Stripe Webhookは署名検証（STRIPE_WEBHOOK_SECRET）必須
```

---

## 13. 関連ファイル

| ファイル                                     | 内容                                                   |
| -------------------------------------------- | ------------------------------------------------------ |
| `Motus_Lauda_Pagus_Sentio_連携要件.md`       | 4サービスエコシステム全体設計                          |
| `開発ナレッジ_Stripe500エラー_20260330.docx` | Stripe billing_address_collection バグ対応（横断適用） |
| `Motus_引き継ぎ書_20260330.md`               | Motusの実装パターン参照                                |
| `Lauda_進捗アップデート_20260330.docx`       | Laudaの実装パターン参照                                |

---

## 14. マルチエージェントハーネス（Planner→Generator→Evaluator）

このプロジェクトでは Anthropic の「Harness design for long-running apps」手法に基づく3エージェント構成を採用する。

| エージェント  | 役割                               | Sentioでの適用例                                             |
| ------------- | ---------------------------------- | ------------------------------------------------------------ |
| **Planner**   | タスクを構造化・分割・優先順位付け | 「どの機能を・どの順番で・どう実装するか」計画               |
| **Generator** | コンテンツ・コード・文書を生成     | so whatプロンプト・Edge Function・HTML/CSS生成               |
| **Evaluator** | 品質チェック・so what品質基準評価  | 「具体的な行動が書かれているか・抽象論になっていないか」評価 |

> ウィジェット生成が必要な場合は「3エージェントウィジェットを生成して」と指示する。

---

_SENTIO | 株式会社ディセーノ | 初版：2026年3月31日 | 梶谷将太郎 × Claude_
