# SENTIO — Claude Code 作業指示書

> このファイルはClaude Codeが起動時に自動で読み込む設定ファイルです。
> 作業を始める前に必ずこのファイルを読み込んでください。
> 詳細設計は `SENTIO_ProjectContext.md` を参照すること。

---

## プロジェクト概要

**SENTIO**（センティオ）— データを「so what」に変える、中小企業向けAI経営判断エンジン

- **コンセプト**：BIツールではなく「翻訳者」。数字ではなく判断を届ける
- **タグライン**：データが多すぎる。判断が足りない。
- **スタック**：HTML/CSS/JS + Supabase + Vercel + Stripe + Claude API
- **ドメイン**：sentio-ai.jp（要取得確認）
- **リポジトリ**：github.com/shotarokajitani/sentio

---

## ディレクトリ構成

```
sentio/
├── CLAUDE.md                    ← このファイル
├── SENTIO_ProjectContext.md     ← 詳細設計書（必読）
├── index.html                   ← LP
├── app.html                     ← ダッシュボード（シングルページ・タブ切替）
├── styles.css                   ← 共通スタイル
├── supabase/
│   └── functions/
│       ├── generate-so-what/    ← コア：so what生成
│       │   └── index.ts
│       ├── create-checkout/     ← Stripe決済
│       │   └── index.ts
│       ├── stripe-webhook/      ← 課金完了・解約処理
│       │   └── index.ts
│       ├── create-portal-link/  ← Stripeポータル
│       │   └── index.ts
│       ├── generate-report/     ← 月次PDF生成
│       │   └── index.ts
│       └── send-report/         ← Resend PDF送付
│           └── index.ts
└── .gitignore
```

---

## デザイン原則（絶対ルール）

```
カラー：
  背景     #0f0f13   ダークバック
  アクセント #7c3aed  パープル（ブランドカラー）
  成功・強調 #34d399  エメラルドグリーン
  テキスト  #e8e0d0  オフホワイト
  サブテキスト #888888 グレー
  ボーダー  #2a2a3a  ダークグレー

フォント：
  見出し    Cormorant Garamond（Google Fonts）
  本文      Inter（Google Fonts）

トーン：
  Bloomberg端末・金融系UIの落ち着き
  派手な色・過剰なアニメーション禁止
  情報は多く、見た目はすっきり
```

**参照デザイン（平仄を合わせること）：**

- Lauda：www.lauda-ai.com
- Motus：www.motus-ai.jp

---

## Supabase 設定

| 項目           | 値                                                                                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| プロジェクト名 | sentio                                                                                                                                                                                                           |
| リージョン     | **東京（ap-northeast-1）必須**                                                                                                                                                                                   |
| Auth           | メール/パスワード認証                                                                                                                                                                                            |
| Project Ref    | kwpldqbnkraftaahnpev                                                                                                                                                                                             |
| Supabase URL   | https://kwpldqbnkraftaahnpev.supabase.co                                                                                                                                                                         |
| Anon Key       | eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt3cGxkcWJua3JhZnRhYWhucGV2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5MjQxNTMsImV4cCI6MjA5MDUwMDE1M30.Jec0fNpaJQuQWQ88RJEDJtcif-fXs0aauPOpcbDr5Ig |

### 登録が必要な Secrets

```
ANTHROPIC_API_KEY     → Claude APIキー
STRIPE_SECRET_KEY     → Stripe本番秘密キー
STRIPE_WEBHOOK_SECRET → Webhook署名シークレット
STRIPE_PRICE_STARTER  → ¥9,800プランのPrice ID
STRIPE_PRICE_GROWTH   → ¥29,800プランのPrice ID
STRIPE_PRICE_SCALE    → ¥79,800プランのPrice ID
RESEND_API_KEY        → PDF送付用
```

---

## Stripe 実装ルール（⚠️ 最重要）

> **2026年3月30日 Laudaで発生した本番障害。全プロジェクト横断適用。**

`mode: 'subscription'` では以下を**絶対に指定しない**：

```typescript
// ❌ これを書くと500エラー
billing_address_collection: "required";
customer_creation: "always";

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

## デプロイコマンド

```powershell
# Edge Function デプロイ（SUPABASE_PROJECT_REFは作成後に確認）
npx supabase functions deploy generate-so-what  --no-verify-jwt --project-ref kwpldqbnkraftaahnpev
npx supabase functions deploy create-checkout   --no-verify-jwt --project-ref kwpldqbnkraftaahnpev
npx supabase functions deploy stripe-webhook    --no-verify-jwt --project-ref kwpldqbnkraftaahnpev
npx supabase functions deploy create-portal-link --no-verify-jwt --project-ref kwpldqbnkraftaahnpev
npx supabase functions deploy generate-report   --no-verify-jwt --project-ref kwpldqbnkraftaahnpev
npx supabase functions deploy send-report       --no-verify-jwt --project-ref kwpldqbnkraftaahnpev

# フロントエンドデプロイ（Vercel 自動）
git add . && git commit -m "[変更内容]" && git push
```

---

## 作業の原則

### 着手前チェック

```
□ SENTIO_ProjectContext.md のセクション2（プロダクト哲学）を確認した
□ so whatの品質基準（良い例・悪い例）を確認した
□ デザインカラー・フォントが正しく設定されているか
□ Stripeの禁止パラメータを追加していないか
□ 全テーブルにRLS（Row Level Security）を設定したか
```

### コーディング規則

```
□ Edge FunctionはTypeScriptで実装する
□ エラーハンドリングは必ずtry-catchで行う
□ Supabase操作はサーバーサイド（Edge Function）で行う
□ フロントエンドにAPIキーを露出させない（anon keyのみ可）
□ 変更前は必ず .bak でバックアップを作成する
```

### 完了報告フォーマット

```
✅ バックアップ：.bakファイル作成済み（該当する場合）
✅ 修正ファイル：（ファイル名）
✅ 確認URL：（該当URL）
✅ セルフチェック：（確認事項と結果）
```

---

## 現在の開発状況（2026年3月31日時点）

```
✅ SENTIO_ProjectContext.md 作成完了
✅ CLAUDE.md 作成完了
✅ GitHubリポジトリ作成
✅ Supabaseプロジェクト作成（東京リージョン）
✅ DBスキーマ実行（6テーブル）
✅ Vercel デプロイ設定
✅ sentio-ai.jp ドメイン設定（DNS浸透待ち）
✅ Supabase Secrets登録（ANTHROPIC_API_KEY）
✅ index.html（LP）作成
✅ app.html（ダッシュボード）作成
⬜ generate-so-what Edge Function 実装
⬜ Stripe 3プラン設定・決済フロー実装
⬜ エンドツーエンドテスト
```

---

## 関連サービスのリンク（作成後に記入）

| サービス           | URL                                                         |
| ------------------ | ----------------------------------------------------------- |
| LP                 | https://www.sentio-ai.jp                                    |
| アプリ             | https://www.sentio-ai.jp/app.html                           |
| GitHub             | https://github.com/shotarokajitani/sentio                   |
| Vercel             | https://vercel.com/diseno1/sentio                           |
| Supabase Dashboard | https://supabase.com/dashboard/project/kwpldqbnkraftaahnpev |
| Stripe Dashboard   | https://dashboard.stripe.com                                |

---

_SENTIO | 株式会社ディセーノ | 2026年3月31日 | 梶谷将太郎 × Claude_
