# ADR-0001: 技術スタック（0ベース再構築）

状態: accepted / 決定日: 2026-07-02（設計議論で確定済みの内容の文書化）

- フロントエンド: Next.js（App Router）+ TypeScript。静的HTML構成は廃止（「触ると壊れる」の主因対策）
- 契約: zodスキーマを shared/contracts/ に置き、フロントとEdge Functionが同一契約を共有
- バックエンド: Supabase（既存契約流用: Auth / Postgres / Edge Functions(Deno) / Vault / pg_cron）
- テスト: Vitest（単体・契約）+ Playwright（E2E, sprint-evaluatorが使用）
- パッケージ: pnpm / Lint: ESLint + Prettier（設定はスライス1で初期化）
- 配信: Resend（メール）。LINE/Slack/CW配信チャネルはスライス3以降
- 監視: Sentry（スクラビング必須）
- AI: Anthropic API。モデルIDはハードコードせず環境変数（モデル更新＝縮退テストの契機）
  却下案: 静的HTML継続（状態管理・契約不在で再発リスク）/ 外部KMS導入（現段階ではVaultで十分、Phase3で再評価）
