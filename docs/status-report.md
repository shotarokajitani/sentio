# Slice-01 ウォーキングスケルトン — 実装状況レポート

更新: 2026-07-15  
ブランチ: `feat/slice-01-walking-skeleton`  
最新コミット: `dcd2999` feat(eval): add synthetic company generator and engine eval suite (D1-D2)

---

## テスト結果

| 区分 | 数 |
|------|----|
| Test Files passed | 20 |
| Test Files skipped | 3 (統合テスト — Supabase未起動時) |
| Tests passed | 125 |
| Tests skipped | 7 (同上) |
| Tests failed | 0 |

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

実装物:
- `src/state/baselines.ts` — median/IQR/P25/P75、minObs閾値 (C1)
- `src/state/company-summary.ts` — 5章固定構造、MAX_SUMMARY_TOKENS=4000 (C2)
- `src/state/memory-packet.ts` — priority順組立、summary常備、token budget内切詰め (C3)
- `src/state/narratives.ts` — confidence 30日半減期、correction即時減算、upsert

### Phase 5: Sense層 (D1-D6) — 完了

| Task | コミット | 内容 |
|------|----------|------|
| 5.1-5.4 | `faa78e5` | Scanner / Evaluator / Finding lifecycle |

実装物:
- `src/sense/scanner.ts` — 5走査 (deviation/trend/silence/deadline/external)、LLMなし (D1)
- `src/sense/evaluator.ts` — 5基準名、revise上限2、Generator推論排除 (D3)
- `src/sense/finding-lifecycle.ts` — open/watching/resolved/expired、再検知マージ (D6)
- Edge Functions: `scan/index.ts`, `investigate/index.ts` (スタブ)

### Phase 6: Act層 (E1-E5) — 完了

| Task | コミット | 内容 |
|------|----------|------|
| 6.1-6.5 | `3ed78e4` | weekly / alert / quiet-hours / onetap / pulse |

実装物:
- `src/act/weekly-renderer.ts` — 5セクション固定順、Finding 0-2件 (E1-E2)
- `src/act/alert-renderer.ts` — 事実+リンクのみ、解釈文禁止 (E3)
- `src/act/quiet-hours.ts` — 23-6時JST集約、site_down例外 (E5)
- `src/act/onetap-calendar.ts` — draft/confirmed、承認前送信なし (E4)

### Phase 7: Day0 統合 (A1-A5) — 完了

| Task | コミット | 内容 |
|------|----------|------|
| 7.1-7.2 | `df4ece4` | Day0 8ブロックレポート生成 |

実装物:
- `src/day0/day0-report.ts` — 8ブロック固定キー、sources配列、断定表現なし
- concern → initial_hypothesis 交差、URL不達時の graceful degradation

### Phase 8: セキュリティ横断 (F1-F5) — 一部完了

| Task | コミット | 状態 |
|------|----------|------|
| F1 | `9fc5331` | pass — allowlist + migration でトークン列なし |
| F2 | `ba9e570` | pass — RLS 統合テスト + migration 00013 |
| F3 | `8499da0` | pass — Stripe/Slack/LINE 署名検証 |
| F4 | — | **pending** — CI gitleaks-action 設定待ち |
| F5 | — | **pending** — CI プレビュー環境検査スクリプト未作成 |

### Phase 9: 合成会社 + 統合テスト — 一部完了

| Task | コミット | 状態 |
|------|----------|------|
| 9.1 | `dcd2999` | 完了 — 合成会社生成 + engine eval suite |
| 9.2 | — | **未着手** — Playwright E2E (プレビュー環境前提) |

---

## 契約基準 採点サマリ

| 基準群 | 結果 | 備考 |
|--------|------|------|
| A1-A5 | 5/5 pass | 単体テストで検証済み。E2Eは Phase 9.2 |
| B1-B6 | 6/6 pass | CSV冪等性 + allowlist |
| C1-C3 | 3/3 pass | baselines / summary / memory-packet |
| D1-D6 | 6/6 pass | Scanner eval suite 含む |
| E1-E5 | 5/5 pass | weekly / alert / quiet-hours / onetap |
| F1-F3 | 3/3 pass | Vault隔離 / RLS / 署名検証 |
| F4-F5 | pending | CI設定依存 |
| G1-G2 | 手動 | sprint-evaluator対象外 |

**合計: 28/28 pass + 2 pending (CI) + 2 手動**

---

## 未完了・保留事項

1. ~~**F4 (gitleaks)**~~ → **完了** (`4af5d88`) gitleaks を独立ジョブに分離、dependabot.yml 追加
2. **F5 (プレビュー環境検査)** — Supabase プレビューブランチ + Vercel preview のデプロイ後に検査スクリプトを追加
3. **Phase 9.2 (Playwright E2E)** — ローカルフルスタック＋合成会社で実施予定（契約環境条項の暫定解釈）
4. ~~**Edge Function の結合**~~ → **コード結線完了 [未テスト]** (`9a5572a`) 全11 Edge Function が DB クエリ＋ API 呼び出しを実装済み。ライブ検証は Docker + 環境変数設定後
5. ~~**Investigator フルハーネス**~~ → **コード結線完了 [未テスト]** Planner→Generator→Evaluator パイプライン実装済み。prompts/ ランタイム読み込み、ANTHROPIC_MODEL 環境変数、Evaluator 独立性（finding+evidence のみ）

## ブロッカー（環境準備待ち）

Task 2 (統合テスト skip 解消) → Task 4 (sprint-evaluator 採点) は以下が必要:

| 要件 | 状態 |
|------|------|
| Docker Desktop 起動 | 未インストール (`docker: command not found`) |
| `supabase start` 実行 | Docker が前提のため起動不可 |
| `.env` に値を設定 | `.env.example` に変数名一覧を記載済み |

**規律: 環境準備完了の通知を受けたら、他作業より先に Task 2 で統合テストを遡って検証する。未検証のまま Task 4 へ進むことは禁止。**
