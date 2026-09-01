# Sentio — プロジェクト憲法（索引）

Sentioは、誰にも報告させず・入力させずに会社の状態を吸い上げ、判断に変えるSME向けサービス。
「無意識の収集」が製品の前半、「翻訳」が後半。**迷ったときの判断基準はアンチ・セールスフォース**（「入力を要求していないか」を確認）。

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

## 常設指示（Diseno AI協働運用ルール §4 準拠）

- **申告の禁止事項**: 試さずに「できない」と申告しない。実行せずに「完了」と報告しない。実測可能なことは実測し、実行結果の実物（レスポンス・ログ）を引用して報告する
- **CI監視の定型化**: push後はCI全ジョブの完了を自律監視し、完了時に「全ジョブ結果＋実行実態証跡（skip有無・実行時間）」を定型報告する
- **一次自己検収**: 完了報告の前に自己検収し、証跡（ログ引用・実測値）を添えて報告する。証跡のない完了報告は再提出
- **人間作業のバッチ化**: 人間側の作業（Dashboard操作等）が必要になったら、ブロッカーでない限り即依頼せず貯めて、パートの区切りでまとめて依頼する
- **検証プロセスの後始末**: 検証用に起動したプロセス（dev server等）は作業終了前に停止する
- **Vercel Previewの自律監視**: push後はGitHub Actionsに加え、PRのVercelチェック（`gh pr checks` / `gh api`によるdeployment status取得）も完了まで自律監視する。失敗時はログを取得し、コード側で解決可能なものは自己修正→push→再監視まで自律で回す。Dashboard設定・秘密・課金に触る対応が必要な場合のみ、Chrome拡張向けの指示文案を添えて停止・報告する。人間への報告はパートの区切りで1回に集約する
- 運用ルール正本: `docs/rules/Diseno_AI協働運用ルール_20260812.md`
- 環境差分チェックリスト: `docs/checklists/env-diff.md`（新スキーマ・新コネクタ着手時に必須点検）

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

- 層別規約: `.claude/rules/`（ingest/state/sense/act/security ＋ hooks-coverage / nextjs）
- 手順: `.claude/skills/`（migration / edge-function / synthetic-company / gotchas）
- 採点者: `.claude/agents/sprint-evaluator.md`（レビューはgapのみ報告、スタイル指摘禁止）
- 鍵運用: `docs/secrets-runbook.md` / 事故対応: `docs/incident.md`
- 未確定事項: `docs/spec/07_open_items.md`（勝手に確定させない。人間の判断待ち）
