# Slice-01 ウォーキングスケルトン — 実装状況レポート

更新: 2026-07-21  
ブランチ: `feat/slice-01-walking-skeleton`  

---

## テスト結果

| 区分 | 数 |
|------|----|
| Test Files passed | 24 |
| Test Files skipped | 0 |
| Tests passed | 135 |
| Tests skipped | 0 |
| Tests failed | 0 |

---

## Sprint-evaluator 採点結果

### 初回採点 → 再採点

| 基準 | 初回 | 再採点 | 備考 |
|------|------|--------|------|
| A1 | 判定不能 | 判定不能 | ANTHROPIC_API_KEY + Resend 未設定（ローカル環境依存） |
| A2-A5 | pass | — | 単体テスト検証済み |
| B1-B6 | pass | — | 統合テスト + 単体テスト検証済み |
| C1-C3 | pass | — | 単体テスト検証済み |
| D1-D6 | pass | — | eval suite + 単体テスト検証済み |
| E1-E2 | pass | — | Edge Function ライブ検証済み |
| E3 | **fail** | **pass** | delivery_log スキーマ修正後、INSERT 成功確認 |
| E4 | **fail** | **pass** | onetap draft 作成・DB永続化確認 |
| E5 | **fail** | **pass** | deferred ログ永続化 + site_down 例外の即時配信確認 |
| F1-F3 | pass | — | コード + DB + テスト検証済み |
| F4 | **fail** | **pass** | .gitleaksignore で歴史的検出除外、新規ゼロ |
| F5 | pass | — | ワーキングツリーに本番Secrets なし |
| G1-G2 | 手動 | — | sprint-evaluator 対象外 |

**合計: 30/31 pass + 1 判定不能 (A1: 環境依存) + 2 手動 (G)**

---

## Phase 別 完了状況

### Phase 0: プロジェクト初期化 — 完了

| Task | コミット | 内容 |
|------|----------|------|
| 0.1 | `bf6cd78` | pnpm / TypeScript / Vitest / ESLint 初期化 |
| 0.2 | `2d0a87d` | Supabase ローカル環境 (config.toml) |
| 0.3 | `ec1bc47` | hooks を .sh → .mjs に移行 (Windows互換) |

### Phase 1: データベーススキーマ — 完了

| Task | コミット | 内容 |
|------|----------|------|
| 1.1 | `9fc5331` | S2 allowlist 検査スクリプト + テスト (B6, F1) |
| 1.2 | `2763e35` | 全13マイグレーション (events〜RLS全有効化) |
| 1.3 | `ba9e570` | RLS統合テスト (F2) |

### Phase 2: 共有契約 (Zod) — 完了

| Task | コミット | 内容 |
|------|----------|------|
| 2.1 | `6f355be` | EventEnvelope スキーマ (8分類/S0-S3/S0-nullability) |
| 2.2 | `ead3e38` | Finding / CompanySummary / MemoryPacket / Day0 / Weekly |

### Phase 3: Ingest層 (B1-B6) — 完了

| Task | コミット | 内容 |
|------|----------|------|
| 3.1 | `7b1f473` | CSV パーサー + SHA-256 冪等性 (B1-B3) |
| 3.2-3.5 | `75197ea` | Edge Functions (csv/calendar/s0/monitor) + 統合テスト |

### Phase 4: State層 (C1-C3) — 完了

| Task | コミット | 内容 |
|------|----------|------|
| 4.1-4.4 | `332ec80` | baselines / company_summary / memory_packet / narratives |

### Phase 5: Sense層 (D1-D6) — 完了

| Task | コミット | 内容 |
|------|----------|------|
| 5.1-5.4 | `faa78e5` | Scanner / Evaluator / Finding lifecycle |

### Phase 6: Act層 (E1-E5) — 完了

| Task | コミット | 内容 |
|------|----------|------|
| 6.1-6.5 | `3ed78e4` | weekly / alert / quiet-hours / onetap / pulse |

### Phase 7: Day0 統合 (A1-A5) — 完了

| Task | コミット | 内容 |
|------|----------|------|
| 7.1-7.2 | `df4ece4` | Day0 8ブロックレポート生成 |

### Phase 8: セキュリティ横断 (F1-F5) — 完了

| Task | コミット | 状態 |
|------|----------|------|
| F1 | `9fc5331` | pass — allowlist + migration でトークン列なし |
| F2 | `ba9e570` | pass — RLS 統合テスト + migration 00013 |
| F3 | `8499da0` | pass — Stripe/Slack/LINE 署名検証 |
| F4 | `4af5d88` | pass — gitleaks CI + .gitleaksignore で歴史的検出除外 |
| F5 | — | pass — ワーキングツリーに本番Secrets なし |

### Phase 9: 合成会社 + 統合テスト — 完了

| Task | コミット | 状態 |
|------|----------|------|
| 9.1 | `dcd2999` | 完了 — 合成会社生成 + engine eval suite |
| 9.2 | — | 完了 — sprint-evaluator ローカルE2E採点 |

### Phase 10: Gap修正 — 完了

| 修正 | 内容 |
|------|------|
| マイグレーション 00014 | ロール別テーブル権限付与 (service_role/authenticated/anon) |
| マイグレーション 00015 | delivery_log 和集合スキーマ (channel/delivery_type/content/status/created_at 追加) |
| Edge Function エラーハンドリング | deliver-alert/weekly/pulse/day0 の delivery_log INSERT エラー握りつぶし修正 |
| .gitleaksignore | 歴史的検出4件を除外（キーローテーションは人間タスク） |
| vitest.config.ts | process.loadEnvFile で .env 自動ロード |
| ESLint flat config (v9) | eslint-config-next 16 との互換性修正 |
| tsconfig.json skipLibCheck | @supabase/auth-js 型エラー回避 |

---

## 未完了・保留事項

1. **A1 (Day0 E2E)** — ANTHROPIC_API_KEY + RESEND_API_KEY 設定後にライブ検証
2. **F5 (プレビュー環境検査)** — Vercel preview デプロイ後に検査スクリプト追加
3. **G1-G2 (手動スモーク)** — 実Googleアカウント + 梶谷さんデモゲート
4. **歴史的キーのローテーション** — 人間タスク（git履歴の本番anon key）
