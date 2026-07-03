---
name: gotchas
description: 実際に踏んだ失敗の蓄積。原因調査・実装判断で迷ったら最初に参照。新しい失敗は必ずここに追記。
---

# Gotchas（実績ベース）

- Stripe: サブスクで billing_address_collection / customer_creation → 500エラー（Lauda実績）
- KING OF TIME: JST 8:30–10:00 / 17:30–18:30 接続禁止。cronはUTC 02:00以降
- BOJ API: 本番公開時に post.rsd17@boj.or.jp へ通知＋クレジット表示が必要
- Slack: 2025/5/29以降、非Marketplaceアプリの conversations.history は1req/分・15件（9/2以降既存にも適用）→遡及不可、前向き収集のみ
- Supabase Vault: INSERT文がstatement logに平文で残る→statement logging OFF必須。復号はdecrypted_secretsビュー
- Instagram: インサイトの過去遡及は弱い（前向き収集型）。アプリレビュー必須・レート制限あり
- docx正本問題: docxは環境によりzipとして読めない。正本は必ずMarkdown、docxは配布用エクスポート
- 週次「問い」の詰め込み: Findingは0〜2件。3件以上は読了率が落ちる前提で設計（統制ルール）
- GBP API: 有効化と承認は別物。クォータ0 QPM=未承認、300=承認済み。申請はapi_defaultフォーム（Basic API Access）、
  60日以上アクティブな自社GBP＋オーナー権限メールが要件（Lauda実地・2026-07）
- Vault実装（security definer関数・トークン暗号化・180日削除）はLaudaに本番稼働コードあり。新規発明せず移植する
- AIクローラ（GPTBot/ClaudeBot/PerplexityBot等）はJSを実行しない。公開ページを作る場合は初期HTML/SSGが必須（Lauda調査・2026-06時点）
