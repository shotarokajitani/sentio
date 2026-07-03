# Sentio — プロジェクト憲法（索引）

Sentioは、誰にも報告させず・入力させずに会社の状態を吸い上げ、判断に変えるSME向けサービス。
「無意識の収集」が製品の前半、「翻訳」が後半。北極星は**アンチ・セールスフォース**（迷ったら「入力を要求していないか」を確認）。

- 品質基準（ハード閾値）: **読んだ経営者の頭に、自社の状態が一枚の絵として浮かぶか**。新奇性は加点。
- 正本は `docs/spec/`。この会話やdocxではなく、specのMarkdownが唯一の正。
- 実行単位は `docs/contracts/` のスライス契約。契約基準の全passなくmerge禁止。

## アーキテクチャ（詳細は docs/spec/01〜04）

1. **Ingest**: 全データ源→単一イベントエンベロープ（8分類/S0〜S3）→タイムライン
2. **State**: entities / baselines / narratives / company_summary ＝会社モデル（長期記憶）
3. **Sense**: Scanner（毎日・LLMなし）→ 事実アラート高速路 or Investigator（Planner→Generator→Evaluator）→ Finding台帳
4. **Act**: Day0初回調査 / デイリーパルス / 即時アラート / 週次「今週の会社」/ 月次レーダー ＋「Sentioに聞く」

## 絶対規則（違反はhooks/CIが機械的に拒否）

- S2テーブルに本文型カラムを追加しない（allowlist外カラムのマイグレーション禁止）
- OAuthトークンはSupabase Vault以外のどこにも置かない（イベント・ログ・コード・env含む）
- 本番Project Ref `kwpldqbnkraftaahnpev` へのCLI直接操作禁止。本番反映はCI/CDのみ
- Stripeサブスクで `billing_address_collection` / `customer_creation` を使用しない（500エラー既知）
- KING OF TIME APIはJST 8:30–10:00 / 17:30–18:30 に接続しない（cronはUTC 02:00以降）
- 秘密の値をリポジトリ・ドキュメント・ログに書かない。`.env` は読まない（`.env.example`のみ）
- Sentioは何も勝手に送らない・登録しない（ワンタップは全て下書き/仮登録で停止）
- 全テーブルRLS必須。受信Webhookは署名検証必須

## コマンド（スライス1で初期化。定義後はここが正）

pnpm dev / pnpm typecheck / pnpm lint / pnpm test / pnpm run eval:engine / pnpm run check:allowlist
supabase start（ローカル）/ supabase db reset / supabase functions serve

## 開発ワークフロー

契約合意 → plan mode → TDD（コード化可能な基準はテスト先行）→ hooks/CI →
sprint-evaluator（プレビュー環境＋合成会社でE2E採点）→ エンジン評価スイート → 人間デモゲート → merge

## ポインタ（追加資産）

- 技術スタックの決定: docs/adr/0001-tech-stack.md（スタック変更はADR追記とセット）
- プロンプト正本: prompts/（変更はeval/実行結果の添付必須。コード直書き禁止）
- スキーマ骨子: docs/spec/08_schema.md / 評価スイート: eval/ / MCP: .mcp.json（Playwright）

## ポインタ

- 層別規約: `.claude/rules/`（ingest/state/sense/act/security）
- 手順: `.claude/skills/`（migration / edge-function / synthetic-company / gotchas）
- 採点者: `.claude/agents/sprint-evaluator.md`（レビューはgapのみ報告、スタイル指摘禁止）
- 鍵運用: `docs/secrets-runbook.md` / 事故対応: `docs/incident.md`
- 未確定事項: `docs/spec/07_open_items.md`（勝手に確定させない。人間の判断待ち）
