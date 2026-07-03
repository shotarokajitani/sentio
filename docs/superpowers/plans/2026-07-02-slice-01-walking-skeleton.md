# Slice-01 ウォーキングスケルトン 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新規登録→カレンダー＋会計CSV→タイムライン→会社モデル→Day0レポート＋週次＋稼働監視＋ワンタップ①が本番同等環境で通るウォーキングスケルトンを構築する。

**Architecture:** Supabase (Postgres + Edge Functions + Vault + pg_cron) をバックエンド、Next.js (App Router) をフロントに、4層アーキテクチャ (Ingest→State→Sense→Act) を最小構成で実装。全データはイベントエンベロープに正規化し、Scanner(LLMなし)→Investigator(Anthropic API)→Evaluator の検知パイプラインを通す。配信はResendメール。

**Tech Stack:** TypeScript / Next.js 15 (App Router) / Supabase (Postgres 15, Edge Functions=Deno, Vault, pg_cron) / Vitest / Playwright / pnpm / Resend / Anthropic API / Zod

**承認条件（全Phase共通）:**

1. Evaluator 5基準・Findingテンプレは `prompts/` の正本をランタイムで読み込む。コード内へのプロンプト直書き禁止
2. モデルIDはハードコードせず環境変数 `ANTHROPIC_MODEL` で持つ（ADR-0001準拠）
3. `eval/golden/` のケースラベルはスキル正本 `.claude/skills/synthetic-company/SKILL.md` の仕込み番号（①〜⑧）と一致させる

**契約基準マッピング:**

| 基準  | 実装フェーズ       | TDD対象                                    |
| ----- | ------------------ | ------------------------------------------ |
| A1-A5 | Phase 7 (Day0統合) | A2,A3,A4はEvaluator経由でeval:engine       |
| B1-B6 | Phase 3 (Ingest)   | 全件テスト先行                             |
| C1-C3 | Phase 4 (State)    | 全件テスト先行                             |
| D1-D6 | Phase 5 (Sense)    | 全件テスト先行＋eval:engine                |
| E1-E5 | Phase 6 (Act)      | 全件テスト先行                             |
| F1-F5 | Phase 1,8 (横断)   | F1-F3テスト先行, F4=CI gitleaks, F5=CI検査 |

---

## ファイル構造（作成予定一覧）

```
sentio/
├── package.json                          # pnpm workspace root
├── tsconfig.json
├── vitest.config.ts
├── .eslintrc.cjs / .prettierrc
├── supabase/
│   ├── config.toml
│   ├── migrations/
│   │   ├── 00001_create_events.sql
│   │   ├── 00002_create_entities.sql
│   │   ├── 00003_create_baselines.sql
│   │   ├── 00004_create_narratives.sql
│   │   ├── 00005_create_company_summary.sql
│   │   ├── 00006_create_findings.sql
│   │   ├── 00007_create_connections_and_limits.sql
│   │   ├── 00008_create_known_explanations.sql
│   │   ├── 00009_create_delivery_log.sql
│   │   ├── 00010_create_budget_usage.sql
│   │   ├── 00011_create_misjudgments.sql
│   │   ├── 00012_vault_helpers.sql
│   │   └── 00013_enable_rls_all.sql
│   ├── seed.sql
│   └── functions/
│       ├── _shared/                      # Edge Function共通ユーティリティ
│       │   ├── supabase-client.ts
│       │   ├── envelope.ts               # イベントエンベロープ型＋バリデーション
│       │   ├── vault.ts                  # Vault読み書き(security definer経由)
│       │   └── cors.ts
│       ├── ingest-csv/index.ts           # 会計CSV投入
│       ├── ingest-calendar/index.ts      # カレンダーフィクスチャ注入
│       ├── ingest-s0/index.ts            # S0外部データ取込
│       ├── ingest-monitor/index.ts       # 稼働監視
│       ├── state-baselines/index.ts      # ベースライン再計算
│       ├── state-narratives/index.ts     # narratives upsert
│       ├── state-summary/index.ts        # company_summary再生成
│       ├── state-memory-packet/index.ts  # 記憶パケット編成器
│       ├── scan/index.ts                 # Scanner 5走査
│       ├── investigate/index.ts          # Investigator (Planner→Generator→Evaluator)
│       ├── day0/index.ts                 # Day0バッチ
│       ├── deliver-weekly/index.ts       # 週次メール
│       ├── deliver-alert/index.ts        # 即時アラート
│       ├── deliver-pulse/index.ts        # デイリーパルス
│       └── onetap-calendar/index.ts      # ワンタップ①
├── shared/
│   └── contracts/
│       ├── envelope.ts                   # イベントエンベロープZodスキーマ
│       ├── finding.ts                    # FindingスキーマZod
│       ├── company-summary.ts            # company_summaryスキーマ
│       ├── memory-packet.ts              # 記憶パケットスキーマ
│       ├── day0-report.ts                # Day0レポートスキーマ
│       ├── weekly-report.ts              # 週次レポートスキーマ
│       └── index.ts
├── src/
│   ├── app/                              # Next.js App Router
│   │   ├── layout.tsx
│   │   ├── page.tsx                      # LP（最小）
│   │   ├── auth/callback/route.ts        # OAuth callback
│   │   ├── register/page.tsx             # 登録フォーム
│   │   ├── dashboard/page.tsx            # 最小ダッシュボード
│   │   ├── onetap/[token]/page.tsx       # ワンタップ確認画面
│   │   └── api/
│   │       ├── webhooks/stripe/route.ts  # Stripe Webhook(署名検証)
│   │       └── upload-csv/route.ts       # CSV受付→ingest-csv呼び出し
│   ├── lib/
│   │   ├── supabase/
│   │   │   ├── server.ts                 # サーバーサイドクライアント
│   │   │   └── client.ts                 # ブラウザクライアント
│   │   ├── resend.ts                     # メール送信
│   │   └── anthropic.ts                  # Anthropic APIクライアント
│   └── components/                       # 最小UIコンポーネント
│       ├── register-form.tsx
│       └── csv-upload.tsx
├── scripts/
│   ├── check-allowlist.ts                # S2テーブルallowlistスキーマ検査
│   ├── generate-synthetic-company.ts     # 合成会社生成
│   └── seed-s0.ts                        # S0データシード
├── tests/
│   ├── unit/
│   │   ├── envelope.test.ts              # B1-B3,B5: 冪等性・正規化
│   │   ├── csv-parser.test.ts            # B1-B3: CSV解析・冪等
│   │   ├── baselines.test.ts             # C1: 最低観測数
│   │   ├── memory-packet.test.ts         # C3: パケット編成
│   │   ├── scanner.test.ts               # D1-D2: 検知・誤検知
│   │   ├── evaluator.test.ts             # D3: 5基準判定
│   │   ├── finding-lifecycle.test.ts     # D6: 台帳ライフサイクル
│   │   ├── weekly-renderer.test.ts       # E1-E2: 構成順
│   │   ├── alert-renderer.test.ts        # E3: 解釈文なし
│   │   ├── quiet-hours.test.ts           # E5: 静音時間帯
│   │   └── allowlist.test.ts             # B6,F1: スキーマ検査
│   ├── integration/
│   │   ├── ingest-csv.test.ts            # B1-B3: CSV→DB往復
│   │   ├── ingest-calendar.test.ts       # B4: カレンダーフィクスチャ
│   │   ├── state-pipeline.test.ts        # C1-C2: State再計算
│   │   ├── sense-pipeline.test.ts        # D1-D6: 検知パイプライン
│   │   ├── day0-pipeline.test.ts         # A1-A5: Day0統合
│   │   ├── webhook-signature.test.ts     # F3: 署名検証
│   │   └── rls.test.ts                   # F2: RLS検査
│   └── e2e/                              # Playwright (sprint-evaluator用)
│       └── registration-to-day0.spec.ts  # A1: 登録→Day0
└── eval/
    └── golden/
        ├── positive-01-order-interval/    # ①主要顧客の発注間隔伸長
        ├── positive-02-payment-overdue/   # ②入金予定日の未着
        ├── positive-03-reply-delay/       # ③特定従業員の返信遅延（communicationフィクスチャ直接注入）
        ├── positive-04-overtime-creep/    # ④深夜残業の漸増
        ├── positive-06-inquiry-decline/   # ⑥新規問い合わせ比率低下
        ├── positive-07-meeting-silence/   # ⑦定例会議の消失（途絶）
        ├── positive-08-competitor-hire/   # ⑧競合サイトの採用ページ新設
        ├── negative-05-seasonal-normal/   # ⑤売上の季節性どおりの低下（検知したら即fail）
        ├── negative-extra-01-holiday/     # 追加陰性: 祝日
        ├── negative-extra-02-weather/     # 追加陰性: 天候
        └── negative-extra-03-site-down/   # 追加陰性兼E3検証: サイトダウン（monitor高速路。E3用）
```

---

## Phase 0: プロジェクト初期化

### Task 0.1: pnpm / TypeScript / Vitest / ESLint 初期化

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.eslintrc.cjs`
- Create: `.prettierrc`
- Create: `pnpm-workspace.yaml`（不要なら省略）

- [ ] **Step 1: package.json を作成**

```bash
cd C:/Users/shota/sentio
pnpm init
```

- [ ] **Step 2: 依存パッケージをインストール**

```bash
pnpm add next@latest react react-dom zod @supabase/supabase-js @supabase/ssr resend @anthropic-ai/sdk
pnpm add -D typescript @types/node @types/react @types/react-dom vitest @vitejs/plugin-react eslint prettier eslint-config-next @playwright/test gitleaks
```

- [ ] **Step 3: tsconfig.json を作成**

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "incremental": true,
    "paths": {
      "@/*": ["./src/*"],
      "@shared/*": ["./shared/*"],
    },
    "plugins": [{ "name": "next" }],
  },
  "include": [
    "src/**/*.ts",
    "src/**/*.tsx",
    "shared/**/*.ts",
    "tests/**/*.ts",
    "scripts/**/*.ts",
    "next-env.d.ts",
  ],
  "exclude": ["node_modules", "supabase/functions"],
}
```

- [ ] **Step 4: vitest.config.ts を作成**

```typescript
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
});
```

- [ ] **Step 5: package.json の scripts を設定**

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "typecheck": "tsc --noEmit",
    "lint": "eslint . --ext .ts,.tsx",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "eval:engine": "vitest run tests/eval/ --reporter=verbose",
    "check:allowlist": "tsx scripts/check-allowlist.ts"
  }
}
```

- [ ] **Step 6: スモークテストを書いて実行**

`tests/unit/smoke.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("vitest is working", () => {
    expect(1 + 1).toBe(2);
  });
});
```

Run: `pnpm test`
Expected: PASS

- [ ] **Step 7: コミット**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts .eslintrc.cjs .prettierrc tests/unit/smoke.test.ts
git commit -m "chore: initialize project with pnpm/TypeScript/Vitest/ESLint"
```

### Task 0.2: Supabase ローカル環境初期化

**Files:**

- Create: `supabase/config.toml`

- [ ] **Step 1: supabase init**

```bash
npx --yes supabase@latest init
```

- [ ] **Step 2: supabase start で動作確認**

```bash
npx --yes supabase start
```

Expected: ローカルのSupabaseコンテナが起動し、URL/anonキーが表示される。

- [ ] **Step 3: コミット**

```bash
git add supabase/
git commit -m "chore: initialize Supabase local environment"
```

### Task 0.3: hooks の Windows 互換化（.sh → .mjs）

**Files:**

- Rewrite: `.claude/hooks/block-env-read.sh` → `.claude/hooks/block-env-read.mjs`
- Rewrite: `.claude/hooks/block-prod-ref.sh` → `.claude/hooks/block-prod-ref.mjs`
- Rewrite: `.claude/hooks/check-secrets-patterns.sh` → `.claude/hooks/check-secrets-patterns.mjs`
- Modify: `.claude/settings.json`

判定ロジック（.env読取拒否・本番Ref操作拒否・秘密パターン遮断）は既存の3本の.shと同等を維持する。
各.mjsは `readFileSync("/dev/stdin","utf8")` でstdin読み取り→パターン検査→deny JSONをstdout出力。
秘密パターンの正規表現は既存.shから移植（パターン自体をコード例に含めるとhookが発火するため、
実装時は既存の .sh ファイルから正規表現を読み取って移植すること）。

settings.json の command を `node $CLAUDE_PROJECT_DIR/.claude/hooks/<name>.mjs` 形式に変更。

- [ ] **Step 1: 3本の .mjs を作成（既存 .sh と同等ロジック）**
- [ ] **Step 2: .claude/settings.json の command を node 実行形式に更新**
- [ ] **Step 3: 旧 .sh ファイルを削除**
- [ ] **Step 4: 3本のhookが実際に発火・拒否することを確認**

確認方法:

1. `.env` ファイルへの Read が deny されること（block-env-read）
2. 本番Project Refを含むコマンドが deny されること（block-prod-ref）
3. 秘密パターンを含むファイル書き込みが deny されること（check-secrets-patterns）

- [ ] **Step 5: コミット**

```bash
git add .claude/hooks/ .claude/settings.json
git commit -m "chore: migrate hooks from bash to Node.js for Windows compatibility"
```

---

## Phase 1: データベーススキーマ（マイグレーション）

**TDD対象:** B6 (allowlist検査), F1 (トークン非存在), F2 (RLS)
**準拠:** docs/spec/08_schema.md, migration skill, security rule

### マイグレーション骨子

全マイグレーションは冪等（`CREATE TABLE IF NOT EXISTS` / `DO $$ ... $$`形式）。
RLSは各テーブル作成マイグレーションと同一ファイル内で有効化。

#### events テーブル（00001）

```sql
CREATE TABLE IF NOT EXISTS events (
  event_id    TEXT PRIMARY KEY,
  company_id  UUID REFERENCES auth.users(id),  -- S0はNULL
  occurred_at TIMESTAMPTZ NOT NULL,
  period_start TIMESTAMPTZ,
  period_end   TIMESTAMPTZ,
  ingested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  source       TEXT NOT NULL,
  event_type   TEXT NOT NULL CHECK (event_type IN (
    'transaction','communication','schedule','attendance',
    'web','external','monitor','dialogue'
  )),
  actor_ref    UUID,
  entity_refs  UUID[] DEFAULT '{}',
  metrics      JSONB DEFAULT '{}',
  sensitivity  TEXT NOT NULL CHECK (sensitivity IN ('S0','S1','S2','S3'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_event_id ON events(event_id);
CREATE INDEX IF NOT EXISTS idx_events_company_occurred ON events(company_id, occurred_at);
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_own_events" ON events FOR ALL
  USING (company_id = auth.uid() OR company_id IS NULL);
```

#### entities（00002）, baselines（00003）, narratives（00004）, company_summary（00005）

spec/08の定義に準拠。全テーブルRLS有効・`company_id = auth.uid()`ポリシー。

#### findings（00006）

status CHECK(open/watching/resolved/expired), urgency CHECK(immediate/weekly/monthly),
evidence_event_ids TEXT[], eval_log JSONB, parent_finding_id参照。

#### connections + connector_limits（00007）

connections: vault_secret_id UUID（Vaultへの参照のみ。トークン本体を持たない）。
connector_limits: provider PKでレート制限を宣言的に格納。

#### known_explanations（00008）, delivery_log（00009）, budget_usage（00010）, misjudgments（00011）

spec/08準拠。

#### vault_helpers（00012）

```sql
-- Laudaから移植: security definer関数でVaultアクセスをラップ
CREATE OR REPLACE FUNCTION store_vault_secret(
  p_name TEXT, p_secret TEXT, p_description TEXT DEFAULT ''
) RETURNS UUID
SECURITY DEFINER
SET search_path = vault, public
LANGUAGE plpgsql AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO vault.secrets (name, secret, description)
  VALUES (p_name, p_secret, p_description)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION read_vault_secret(p_id UUID)
RETURNS TEXT
SECURITY DEFINER
SET search_path = vault, public
LANGUAGE plpgsql AS $$
DECLARE
  v_secret TEXT;
BEGIN
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE id = p_id;
  RETURN v_secret;
END;
$$;
```

#### RLS全有効化確認（00013）

```sql
-- 全テーブルにRLSが有効であることを保証するアサーション（CIで実行）
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('connector_limits') -- 共有テーブルは別ポリシー
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = r.tablename AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'RLS not enabled on table: %', r.tablename;
    END IF;
  END LOOP;
END;
$$;
```

### Task 1.1: allowlist検査スクリプト＋テスト（B6, F1 テスト先行）

**Files:**

- Create: `scripts/check-allowlist.ts`
- Create: `tests/unit/allowlist.test.ts`

- [ ] **Step 1: allowlist検査のテストを書く**

`tests/unit/allowlist.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  validateS2Columns,
  EVENTS_ALLOWLIST,
} from "../../scripts/check-allowlist";

describe("S2 allowlist schema check (B6, F1)", () => {
  it("events テーブルの許可カラムリストが spec/08 と一致する", () => {
    const expected = [
      "event_id",
      "company_id",
      "occurred_at",
      "period_start",
      "period_end",
      "ingested_at",
      "source",
      "event_type",
      "actor_ref",
      "entity_refs",
      "metrics",
      "sensitivity",
    ];
    expect(EVENTS_ALLOWLIST).toEqual(expected);
  });

  it("本文型カラムが存在する場合にエラーを返す", () => {
    const columnsWithBody = [...EVENTS_ALLOWLIST, "body"];
    const result = validateS2Columns(columnsWithBody, EVENTS_ALLOWLIST);
    expect(result.valid).toBe(false);
    expect(result.violations).toContain("body");
  });

  it("許可カラムのみの場合はパスする", () => {
    const result = validateS2Columns(EVENTS_ALLOWLIST, EVENTS_ALLOWLIST);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("token/secret を含むカラム名を検出する", () => {
    const columnsWithToken = [...EVENTS_ALLOWLIST, "access_token"];
    const result = validateS2Columns(columnsWithToken, EVENTS_ALLOWLIST);
    expect(result.valid).toBe(false);
  });
});
```

- [ ] **Step 2: テスト実行 → 失敗を確認**

Run: `pnpm test -- tests/unit/allowlist.test.ts`
Expected: FAIL（モジュール未存在）

- [ ] **Step 3: check-allowlist.ts を実装**

`scripts/check-allowlist.ts`:

```typescript
export const EVENTS_ALLOWLIST = [
  "event_id",
  "company_id",
  "occurred_at",
  "period_start",
  "period_end",
  "ingested_at",
  "source",
  "event_type",
  "actor_ref",
  "entity_refs",
  "metrics",
  "sensitivity",
] as const;

const TOKEN_PATTERNS = /token|secret|password|credential|api_key/i;

export function validateS2Columns(
  actualColumns: string[],
  allowlist: readonly string[],
): { valid: boolean; violations: string[] } {
  const allowSet = new Set(allowlist);
  const violations = actualColumns.filter(
    (col) => !allowSet.has(col) || TOKEN_PATTERNS.test(col),
  );
  return { valid: violations.length === 0, violations };
}

// CLI実行時: Supabaseメタデータから実カラムを取得して検査
if (import.meta.url === `file://${process.argv[1]}`) {
  // supabase inspectionで実テーブルカラムを取得→validateS2Columns
  console.log("check:allowlist — run against live DB");
}
```

- [ ] **Step 4: テスト実行 → パスを確認**

Run: `pnpm test -- tests/unit/allowlist.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add scripts/check-allowlist.ts tests/unit/allowlist.test.ts
git commit -m "feat(security): add S2 allowlist schema checker (B6, F1)"
```

### Task 1.2: マイグレーション作成（spec/08準拠）

**Files:**

- Create: `supabase/migrations/00001_create_events.sql` 〜 `00013_enable_rls_all.sql`

- [ ] **Step 1: events マイグレーション作成**

上記マイグレーション骨子の通り、`supabase/migrations/00001_create_events.sql` を作成。

- [ ] **Step 2〜11: 残りのテーブルを順次作成**

各マイグレーションファイルをspec/08に従い作成。全テーブルでRLS有効化＋ポリシー設定。

- [ ] **Step 12: supabase db reset で適用確認**

```bash
npx --yes supabase db reset
```

Expected: エラーなく全マイグレーションが適用される。

- [ ] **Step 13: コミット**

```bash
git add supabase/migrations/
git commit -m "feat(schema): create all tables per spec/08 with RLS"
```

### Task 1.3: RLS統合テスト（F2 テスト先行）

**Files:**

- Create: `tests/integration/rls.test.ts`

- [ ] **Step 1: RLSテストを書く**

```typescript
import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";

describe("F2: RLS enforcement", () => {
  it("anon ユーザーは他社の events を読めない", async () => {
    // supabase localのanon clientで他社company_idのeventsをSELECT
    // → 0件が返ること
  });

  it("全public テーブルにRLSが有効", async () => {
    // pg_class.relrowsecurity を検査
    const { data } = await adminClient.rpc("check_rls_all_tables");
    expect(data.every((t: any) => t.rls_enabled)).toBe(true);
  });
});
```

- [ ] **Step 2: 実行 → テストの方針に従い実装・パスを確認**

---

## Phase 2: 共有契約（Zodスキーマ）

### Task 2.1: イベントエンベロープ契約（B基準の型基盤）

**Files:**

- Create: `shared/contracts/envelope.ts`
- Create: `tests/unit/envelope.test.ts`

- [ ] **Step 1: エンベロープのテストを書く**

`tests/unit/envelope.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { EventEnvelope, parseEnvelope } from "@shared/contracts/envelope";

describe("EventEnvelope contract", () => {
  const validEvent = {
    event_id: "hash_freee_txn_001",
    company_id: "550e8400-e29b-41d4-a716-446655440000",
    occurred_at: "2026-06-15T10:00:00Z",
    ingested_at: "2026-07-01T00:00:00Z",
    source: "freee:v1",
    event_type: "transaction",
    metrics: { amount: 150000, tax: 15000 },
    sensitivity: "S1",
  };

  it("有効なイベントをパースできる", () => {
    const result = parseEnvelope(validEvent);
    expect(result.success).toBe(true);
  });

  it("event_type が8分類外ならエラー", () => {
    const result = parseEnvelope({ ...validEvent, event_type: "unknown" });
    expect(result.success).toBe(false);
  });

  it("sensitivity が S0-S3 外ならエラー", () => {
    const result = parseEnvelope({ ...validEvent, sensitivity: "S4" });
    expect(result.success).toBe(false);
  });

  it("S0 は company_id = null を許容", () => {
    const result = parseEnvelope({
      ...validEvent,
      company_id: null,
      sensitivity: "S0",
    });
    expect(result.success).toBe(true);
  });

  it("S1以上は company_id 必須", () => {
    const result = parseEnvelope({
      ...validEvent,
      company_id: null,
      sensitivity: "S1",
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: テスト失敗を確認**
- [ ] **Step 3: envelope.ts を実装**

```typescript
import { z } from "zod";

const EVENT_TYPES = [
  "transaction",
  "communication",
  "schedule",
  "attendance",
  "web",
  "external",
  "monitor",
  "dialogue",
] as const;

const SENSITIVITIES = ["S0", "S1", "S2", "S3"] as const;

export const EventEnvelope = z
  .object({
    event_id: z.string().min(1),
    company_id: z.string().uuid().nullable(),
    occurred_at: z.string().datetime(),
    period_start: z.string().datetime().optional(),
    period_end: z.string().datetime().optional(),
    ingested_at: z.string().datetime(),
    source: z.string().min(1),
    event_type: z.enum(EVENT_TYPES),
    actor_ref: z.string().uuid().optional(),
    entity_refs: z.array(z.string().uuid()).default([]),
    metrics: z.record(z.unknown()).default({}),
    sensitivity: z.enum(SENSITIVITIES),
  })
  .refine((e) => e.sensitivity === "S0" || e.company_id !== null, {
    message: "S1以上は company_id 必須",
  });

export type EventEnvelopeType = z.infer<typeof EventEnvelope>;
export const parseEnvelope = (data: unknown) => EventEnvelope.safeParse(data);
```

- [ ] **Step 4: テスト実行 → パス**
- [ ] **Step 5: コミット**

### Task 2.2: Finding / company_summary / memory-packet / day0-report / weekly-report 契約

**Files:**

- Create: `shared/contracts/finding.ts`
- Create: `shared/contracts/company-summary.ts`
- Create: `shared/contracts/memory-packet.ts`
- Create: `shared/contracts/day0-report.ts`
- Create: `shared/contracts/weekly-report.ts`
- Create: `shared/contracts/index.ts`
- Create: 各テストファイル

各スキーマをspec/03, spec/04の定義に従いZodで定義。TDDで進行。

Finding契約の重要フィールド:

- `evidence_event_ids: z.array(z.string()).min(1)` — D5: 証拠リンク必須
- `eval_log: z.object(...)` — D3: Evaluator判定ログ
- `urgency: z.enum(["immediate", "weekly", "monthly"])`
- `status: z.enum(["open", "watching", "resolved", "expired"])`
- `hypotheses: z.array(...).min(3)` — Sense rule: 仮説3件未満のFinding禁止

---

## Phase 3: Ingest層（B1-B6）

### Task 3.1: CSV パーサー＋冪等性テスト（B1-B3 テスト先行）

**Files:**

- Create: `src/ingest/csv-parser.ts`
- Create: `tests/unit/csv-parser.test.ts`

- [ ] **Step 1: CSV冪等性のテストを書く**

`tests/unit/csv-parser.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseCsvToEnvelopes, generateEventId } from "@/ingest/csv-parser";

describe("CSV→EventEnvelope (B1-B3)", () => {
  const sampleCsv = `date,description,amount,tax
2026-06-01,売上A,100000,10000
2026-06-02,仕入B,-50000,-5000`;

  const fileFingerprint = "sha256:abc123";

  it("B1: CSVを正しくtransactionイベントに変換する", () => {
    const envelopes = parseCsvToEnvelopes(
      sampleCsv,
      fileFingerprint,
      "company-uuid",
    );
    expect(envelopes).toHaveLength(2);
    expect(envelopes[0].event_type).toBe("transaction");
    expect(envelopes[0].metrics).toEqual({ amount: 100000, tax: 10000 });
  });

  it("B1: 金額合計がCSVと一致する", () => {
    const envelopes = parseCsvToEnvelopes(
      sampleCsv,
      fileFingerprint,
      "company-uuid",
    );
    const total = envelopes.reduce(
      (sum, e) => sum + (e.metrics.amount as number),
      0,
    );
    expect(total).toBe(50000); // 100000 + (-50000)
  });

  it("B2: 同一CSVの再投入で同じ event_id が生成される（冪等）", () => {
    const first = parseCsvToEnvelopes(
      sampleCsv,
      fileFingerprint,
      "company-uuid",
    );
    const second = parseCsvToEnvelopes(
      sampleCsv,
      fileFingerprint,
      "company-uuid",
    );
    expect(first.map((e) => e.event_id)).toEqual(second.map((e) => e.event_id));
  });

  it("B3: 修正済みCSVは変更行のみ新しいevent_idになる", () => {
    const modified = sampleCsv.replace("100000", "120000");
    const original = parseCsvToEnvelopes(
      sampleCsv,
      fileFingerprint,
      "company-uuid",
    );
    const updated = parseCsvToEnvelopes(
      modified,
      fileFingerprint,
      "company-uuid",
    );
    // 1行目のevent_idが変わり、2行目は同じ
    expect(updated[0].event_id).not.toBe(original[0].event_id);
    expect(updated[1].event_id).toBe(original[1].event_id);
  });

  it("event_id = hash(file_fingerprint, row_content)", () => {
    const id = generateEventId(
      fileFingerprint,
      "2026-06-01,売上A,100000,10000",
    );
    expect(id).toMatch(/^[a-f0-9]{64}$/); // SHA-256
  });
});
```

- [ ] **Step 2: テスト失敗確認**
- [ ] **Step 3: csv-parser.ts 実装**
- [ ] **Step 4: テストパス確認**
- [ ] **Step 5: コミット**

### Task 3.2: CSV投入の統合テスト（B1-B3 DB往復）

**Files:**

- Create: `tests/integration/ingest-csv.test.ts`
- Create: `supabase/functions/ingest-csv/index.ts`

- [ ] **Step 1: 統合テストを書く**

```typescript
describe("CSV ingest integration (B1-B3)", () => {
  it("B1: CSV投入後にtransactionイベントがタイムラインに存在する", async () => {
    // CSV投入 → events テーブルSELECT → 件数・金額合計を検証
  });

  it("B2: 同一CSV再投入で件数が増えない（UPSERT冪等）", async () => {
    // 同一CSV 2回投入 → events件数が1回目と同じ
  });

  it("B3: 修正CSV再投入は差分行のみ新イベント", async () => {
    // 修正CSV投入 → 変更行のevent_idが新規、未変更行は同一
  });
});
```

- [ ] **Step 2〜5: 実装→テストパス→コミット**

### Task 3.3: カレンダーフィクスチャ注入（B4 テスト先行）

**Files:**

- Create: `supabase/functions/ingest-calendar/index.ts`
- Create: `tests/integration/ingest-calendar.test.ts`

- [ ] **Step 1: テストを書く**

```typescript
describe("Calendar fixture injection (B4)", () => {
  it("過去12ヶ月のscheduleイベントが存在する", async () => {
    // フィクスチャ注入 → events WHERE event_type='schedule'
    // occurred_at が過去12ヶ月にまたがること
  });

  it("occurred_at が全て過去である", async () => {
    // 全scheduleイベントの occurred_at < now()
  });
});
```

### Task 3.4: S0データ取込（B5 テスト先行）

**Files:**

- Create: `supabase/functions/ingest-s0/index.ts`
- Create: `scripts/seed-s0.ts`
- Create: `tests/unit/s0-ingest.test.ts`

- [ ] **Step 1: テストを書く**

```typescript
describe("S0 ingest (B5)", () => {
  it("S0 データは company_id=null で格納される", async () => {
    // S0取込 → events WHERE sensitivity='S0' AND company_id IS NULL
  });

  it("S0 データは1回のみ存在する（2社目登録で重複しない）", async () => {
    // 2社分の取込を実行 → S0イベント件数が1回目と同じ
  });
});
```

### Task 3.5: 稼働監視（E3の前提）

**Files:**

- Create: `supabase/functions/ingest-monitor/index.ts`

monitorイベント（サイト死活・SSL・速度）をエンベロープに正規化。
pg_cronで定期実行。immediateアラートの入力源。

---

## Phase 4: State層（C1-C3）

### Task 4.1: ベースライン再計算（C1 テスト先行）

**Files:**

- Create: `supabase/functions/state-baselines/index.ts`
- Create: `tests/unit/baselines.test.ts`

- [ ] **Step 1: テストを書く**

```typescript
describe("Baselines (C1)", () => {
  it("最低観測数未満の指標は is_established=false", () => {
    const result = calculateBaseline(observations3, { minObs: 5 });
    expect(result.is_established).toBe(false);
  });

  it("最低観測数以上の指標は is_established=true で統計値を持つ", () => {
    const result = calculateBaseline(observations10, { minObs: 5 });
    expect(result.is_established).toBe(true);
    expect(result.stats).toHaveProperty("median");
    expect(result.stats).toHaveProperty("iqr");
  });

  it("曜日・季節調整が効いている", () => {
    // 月曜と金曜で異なるベースラインが計算される
  });
});
```

### Task 4.2: company_summary 再生成（C2 テスト先行）

**Files:**

- Create: `supabase/functions/state-summary/index.ts`
- Create: `tests/unit/company-summary.test.ts`

```typescript
describe("company_summary (C2)", () => {
  it("章立てが固定構造に適合する", () => {
    const summary = generateSummary(companyData);
    expect(summary.chapters.map((c: any) => c.key)).toEqual([
      "overview",
      "financial",
      "operations",
      "people",
      "external",
    ]);
  });

  it("トークン上限を超えない", () => {
    const summary = generateSummary(largeCompanyData);
    expect(summary.token_count).toBeLessThanOrEqual(MAX_SUMMARY_TOKENS);
  });
});
```

### Task 4.3: 記憶パケット編成器（C3 テスト先行）

**Files:**

- Create: `supabase/functions/state-memory-packet/index.ts`
- Create: `tests/unit/memory-packet.test.ts`

```typescript
describe("Memory packet assembler (C3)", () => {
  it("上限内のパケットを返す", () => {
    const packet = assemblePacket(companyId, { tokenBudget: 4000 });
    expect(packet.totalTokens).toBeLessThanOrEqual(4000);
  });

  it("超過時は優先度順に切り詰める", () => {
    const packet = assemblePacket(companyId, { tokenBudget: 500 });
    // summaryは常に含まれる（最優先）
    expect(packet.sections).toContainEqual(
      expect.objectContaining({ type: "summary" }),
    );
    // 低優先度のevent断片は切られる
  });

  it("常備セクション(summary)は常に含まれる", () => {
    const packet = assemblePacket(companyId, { tokenBudget: 100 });
    expect(packet.sections[0].type).toBe("summary");
  });
});
```

### Task 4.4: narratives upsert

**Files:**

- Create: `supabase/functions/state-narratives/index.ts`

dialogue由来のnarrative保存。confidence時間減衰ロジック。

---

## Phase 5: Sense層（D1-D6）

### Task 5.1: Scanner 5走査（D1 テスト先行、LLMなし）

**Files:**

- Create: `supabase/functions/scan/index.ts`
- Create: `tests/unit/scanner.test.ts`

- [ ] **Step 1: テストを書く**

```typescript
describe("Scanner (D1-D2, D4)", () => {
  it("乖離走査: ベースラインレンジ逸脱を検知する", () => {
    const candidates = runScan(timelineWithRevenueDrop, baselines);
    expect(candidates.some((c) => c.scanType === "deviation")).toBe(true);
  });

  it("傾向走査: 連続N期同方向を検知する", () => {
    const candidates = runScan(timelineWithDowntrend, baselines);
    expect(candidates.some((c) => c.scanType === "trend")).toBe(true);
  });

  it("途絶走査: 期待発生間隔の超過を検知する", () => {
    const candidates = runScan(timelineWithSilence, baselines);
    expect(candidates.some((c) => c.scanType === "silence")).toBe(true);
  });

  it("期日走査: 入金予定日超過を検知する", () => {
    const candidates = runScan(timelineWithOverdue, baselines);
    expect(candidates.some((c) => c.scanType === "deadline")).toBe(true);
  });

  it("外部着火: S0新着と自社照合で候補を生成する", () => {
    const candidates = runScan(timelineWithS0News, baselines);
    expect(candidates.some((c) => c.scanType === "external")).toBe(true);
  });

  it("D4: monitor/期日のcandidateのみimmediateを返す", () => {
    const candidates = runScan(timelineWithSiteDown, baselines);
    const immediate = candidates.filter(
      (c) => c.suggestedUrgency === "immediate",
    );
    immediate.forEach((c) => {
      expect(["deadline", "monitor"]).toContain(c.source);
    });
  });

  it("ベースライン未成立の指標は候補を生成しない", () => {
    const candidates = runScan(timelineNormal, baselinesNotEstablished);
    expect(candidates).toHaveLength(0);
  });

  it("D2: 陰性コントロール⑤（季節性どおりの売上低下）は検知しない", () => {
    const candidates = runScan(seasonalNormalTimeline, baselines);
    expect(candidates).toHaveLength(0);
  });
});
```

### Task 5.2: Investigator ハーネス（D3, D5 テスト先行）

**承認条件の適用:**
- Evaluator 5基準は `prompts/evaluator_criteria.md` をランタイムで読み込む（コード直書き禁止）
- Findingテンプレは `prompts/finding_template.md` をランタイムで読み込む
- Anthropic APIのモデルIDは `Deno.env.get("ANTHROPIC_MODEL")` で取得（ハードコード禁止）

**Files:**

- Create: `supabase/functions/investigate/index.ts`（Planner→Generator→Evaluator）
- Create: `tests/unit/evaluator.test.ts`

```typescript
describe("Evaluator (D3)", () => {
  it("5基準の判定ログを持つ", () => {
    const evalResult = evaluate(finding, evidence);
    expect(evalResult.criteria).toHaveLength(5);
    evalResult.criteria.forEach((c: any) => {
      expect(c).toHaveProperty("name");
      expect(c).toHaveProperty("pass");
      expect(c).toHaveProperty("reason");
    });
  });

  it("revise は2回以内", () => {
    // revise 3回目で reject になることを確認
  });

  it("Generator の推論過程を Evaluator に渡さない", () => {
    // Evaluator 入力に generatorReasoning フィールドがないことを確認
  });
});
```

### Task 5.3: Finding台帳ライフサイクル（D6 テスト先行）

**Files:**

- Create: `tests/unit/finding-lifecycle.test.ts`

```typescript
describe("Finding lifecycle (D6)", () => {
  it("同一事象の再検知は新規Findingでなくupdateになる", () => {
    const existing = createFinding("revenue_drop_june");
    const redetected = handleRedetection(existing, newEvidence);
    expect(redetected.id).toBe(existing.id); // 同一ID
    expect(redetected.status).toBe("open"); // 再オープン
    expect(redetected.evidence_event_ids.length).toBeGreaterThan(
      existing.evidence_event_ids.length,
    );
  });
});
```

### Task 5.4: D5 証拠リンク検証

```typescript
describe("Finding evidence links (D5)", () => {
  it("全主張の証拠イベントIDがeventsテーブルに存在する", async () => {
    const finding = await generateFinding(companyId);
    for (const eid of finding.evidence_event_ids) {
      const { data } = await supabase
        .from("events")
        .select("event_id")
        .eq("event_id", eid);
      expect(data).toHaveLength(1);
    }
  });
});
```

### Task 5.5: エンジン評価スイート（D1-D2 ゴールデンセット）

**Files:**

- Create: `eval/golden/positive-01-revenue-drop/` 〜 `positive-07-site-down/`
- Create: `eval/golden/negative-01-normal-week/` 〜 `negative-05-hard-negative/`
- Create: `tests/eval/engine.test.ts`

各ゴールデンケースは:

```
input.json    # 合成タイムライン断片＋記憶パケット
expected.json # 期待Finding（陽性）or 期待なし（陰性）
meta.json     # { lang: "ja", type: "positive|negative", description: "..." }
```

```typescript
describe("Engine eval suite (D1-D2)", () => {
  it("D1: 陽性7件中6件以上を検知する", async () => {
    const results = await runEvalSuite("positive");
    const detected = results.filter((r) => r.detected);
    expect(detected.length).toBeGreaterThanOrEqual(6);
  });

  it("D2: 誤検知2件以下", async () => {
    const results = await runEvalSuite("negative");
    const falsePositives = results.filter((r) => r.detected);
    expect(falsePositives.length).toBeLessThanOrEqual(2);
  });

  it("D2: 陰性コントロール⑤（季節性どおりの売上低下）を検知したら即fail", async () => {
    const result = await runEvalCase("negative-05-seasonal-normal");
    expect(result.detected).toBe(false);
  });
});
```

---

## Phase 6: Act層（E1-E5）

### Task 6.1: 週次メールレンダラー（E1-E2 テスト先行）

**Files:**

- Create: `supabase/functions/deliver-weekly/index.ts`
- Create: `tests/unit/weekly-renderer.test.ts`

```typescript
describe("Weekly email renderer (E1-E2)", () => {
  it("E1: 構成順が仕様に適合する", () => {
    const sections = renderWeekly(findings, companyState);
    const order = sections.map((s) => s.type);
    expect(order).toEqual([
      "digest",
      "finding",
      "followup",
      "stable_coverage",
      "nudge",
    ]);
  });

  it("E1: Finding は 0〜2 件", () => {
    const sections = renderWeekly(manyFindings, companyState);
    const findingSections = sections.filter((s) => s.type === "finding");
    expect(findingSections.length).toBeLessThanOrEqual(2);
  });

  it("E1: ナッジは最大1行", () => {
    const sections = renderWeekly(findings, companyState);
    const nudge = sections.find((s) => s.type === "nudge");
    if (nudge) {
      expect(nudge.content.split("\n")).toHaveLength(1);
    }
  });

  it("E2: Findingゼロ週は安定Finding＋カバレッジ数が表示される", () => {
    const sections = renderWeekly([], companyState);
    const stable = sections.find((s) => s.type === "stable_coverage");
    expect(stable).toBeDefined();
    expect(stable!.content).toContain("指標");
    expect(stable!.content).toMatch(/\d+/); // カバレッジ数
  });
});
```

### Task 6.2: 即時アラートレンダラー（E3 テスト先行）

**Files:**

- Create: `supabase/functions/deliver-alert/index.ts`
- Create: `tests/unit/alert-renderer.test.ts`

```typescript
describe("Immediate alert renderer (E3)", () => {
  it("アラート本文に解釈文がない（事実＋リンクのみ）", () => {
    const alert = renderAlert(monitorDownEvent);
    // 解釈パターンを含まない
    expect(alert.body).not.toMatch(/考えられ|推測|可能性|おそらく|思われ/);
    // 事実とリンクのみ
    expect(alert.body).toContain("http");
  });

  it("immediateはmonitor/期日イベントのみ", () => {
    expect(() => renderAlert(llmGeneratedFinding)).toThrow();
  });
});
```

### Task 6.3: 静音時間帯（E5 テスト先行）

**Files:**

- Create: `tests/unit/quiet-hours.test.ts`

```typescript
describe("Quiet hours (E5)", () => {
  it("23:00-6:00 の非例外アラートは翌朝に集約される", () => {
    const result = shouldDeliverNow(
      { urgency: "immediate", category: "ssl_expiry" },
      new Date("2026-07-01T23:30:00+09:00"),
    );
    expect(result.deliver).toBe(false);
    expect(result.deferUntil).toEqual(new Date("2026-07-02T06:00:00+09:00"));
  });

  it("進行中損失（サイトダウン）は静音時間帯でも即時配信", () => {
    const result = shouldDeliverNow(
      { urgency: "immediate", category: "site_down" },
      new Date("2026-07-01T02:00:00+09:00"),
    );
    expect(result.deliver).toBe(true);
  });

  it("6:01 以降は通常配信", () => {
    const result = shouldDeliverNow(
      { urgency: "immediate", category: "ssl_expiry" },
      new Date("2026-07-01T06:01:00+09:00"),
    );
    expect(result.deliver).toBe(true);
  });
});
```

### Task 6.4: ワンタップ①カレンダー仮登録（E4 テスト先行）

**Files:**

- Create: `supabase/functions/onetap-calendar/index.ts`
- Create: `src/app/onetap/[token]/page.tsx`

```typescript
describe("One-tap calendar (E4)", () => {
  it("下書きが生成され、承認前に何も送信・登録されない", () => {
    const draft = createCalendarDraft(findingId, recipientId);
    expect(draft.status).toBe("draft");
    expect(draft.sentAt).toBeNull();
    expect(draft.registeredAt).toBeNull();
  });

  it("承認タップ後のみ仮登録が確定する", () => {
    const draft = createCalendarDraft(findingId, recipientId);
    const confirmed = confirmDraft(draft.id);
    expect(confirmed.status).toBe("confirmed");
  });
});
```

### Task 6.5: デイリーパルス（メール代替）

**Files:**

- Create: `supabase/functions/deliver-pulse/index.ts`

---

## Phase 7: Day0 統合パイプライン（A1-A5）

### Task 7.1: Day0 バッチ（A1-A5 統合テスト先行）

**Files:**

- Create: `supabase/functions/day0/index.ts`
- Create: `tests/integration/day0-pipeline.test.ts`

```typescript
describe("Day0 pipeline (A1-A5)", () => {
  it("A1: 登録→10分以内にDay0レポートメールが生成される", async () => {
    const start = Date.now();
    const report = await runDay0Pipeline(syntheticCompany);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(10 * 60 * 1000);
    expect(report).toBeDefined();
  });

  it("A2: 8ブロック中3ブロック以上が実データで含まれる", async () => {
    const report = await runDay0Pipeline(syntheticCompany);
    const populated = report.blocks.filter((b: any) => b.hasData);
    expect(populated.length).toBeGreaterThanOrEqual(3);
  });

  it("A3: 全事実に出所表記がある＋断定表現がない", async () => {
    const report = await runDay0Pipeline(syntheticCompany);
    report.blocks.forEach((block: any) => {
      if (block.hasData) {
        // 出所表記チェック
        expect(block.content).toMatch(/出所|出典|Source|※/);
        // 断定表現チェック
        expect(block.content).not.toMatch(/である。|に違いない|確実に|必ず/);
      }
    });
  });

  it("A4: 懸念を入力した場合、⑦初期仮説ブロックが懸念に言及する", async () => {
    const report = await runDay0Pipeline({
      ...syntheticCompany,
      concern: "売上が3ヶ月連続で減少している",
    });
    const hypothesisBlock = report.blocks.find(
      (b: any) => b.key === "initial_hypothesis",
    );
    expect(hypothesisBlock).toBeDefined();
    expect(hypothesisBlock!.content).toContain("売上");
  });

  it("A5: URL到達不能な会社でも登録が完了しレポートが届く", async () => {
    const report = await runDay0Pipeline({
      ...syntheticCompany,
      url: "https://unreachable.example.com",
    });
    expect(report).toBeDefined();
    expect(report.blocks.length).toBeGreaterThanOrEqual(1);
  });
});
```

### Task 7.2: Day0 の8ブロック実装

8ブロック（spec/04準拠）:

1. 外から見た自社（URL解析→競合比較）
2. 評判の座標（Places自社vs競合）
3. サイト健全性（SSL期限・速度）
4. 公的記録の非対称（gBizINFO競合との補助金差分）
5. 今使える機会（jGrants締切順トップ3）
6. 業界・地域の位置（e-Stat・日銀）
7. 初期懸念への初期仮説（A4）
8. 見えるようになる地図（接続別カバレッジ予告）

各ブロックはS0データ＋URL解析のみで動作（接続ゼロで動く要件）。

---

## Phase 8: セキュリティ＋横断基準（F1-F5）

### Task 8.1: Webhook署名検証（F3 テスト先行）

**Files:**

- Create: `src/app/api/webhooks/stripe/route.ts`
- Create: `tests/integration/webhook-signature.test.ts`

```typescript
describe("Webhook signature verification (F3)", () => {
  it("正しい署名のリクエストを受理する", async () => {
    const response = await handleStripeWebhook(validSignedRequest);
    expect(response.status).toBe(200);
  });

  it("不正な署名のリクエストを拒否する", async () => {
    const response = await handleStripeWebhook(invalidSignedRequest);
    expect(response.status).toBe(401);
  });

  it("署名ヘッダーがないリクエストを拒否する", async () => {
    const response = await handleStripeWebhook(unsignedRequest);
    expect(response.status).toBe(401);
  });
});
```

### Task 8.2: gitleaks / Secrets検査（F4-F5）

CI (`ci.yml`) に既存のgitleaks-action。
追加: プレビュー環境に本番Secretsが含まれないことの検査スクリプト。

### Task 8.3: Vault統合テスト（F1）

```typescript
describe("Vault token isolation (F1)", () => {
  it("events テーブルにトークン型カラムが存在しない", async () => {
    // allowlist検査を実DBに対して実行
  });

  it("connections テーブルにトークン本体がない（vault_secret_idのみ）", async () => {
    // connections のカラム一覧を検査
  });

  it("ログにトークンが出力されない", async () => {
    // statement_log にトークン値が含まれないことを確認
  });
});
```

---

## Phase 9: 合成会社＋統合テスト

### Task 9.1: 合成会社生成スクリプト

**Files:**

- Create: `scripts/generate-synthetic-company.ts`

**正本: `.claude/skills/synthetic-company/SKILL.md`**
**会社: 株式会社アオバ製作所（架空・BtoB小規模製造）**

- 実在企業・実在人名・実鍵・実連絡先を絶対に含まない（生成側でリスト検査）
- `scripts/generate.ts` が12ヶ月分のイベント（transaction/schedule/communication/attendance）を決定的シードで生成
- CSV/直接投入経路でタイムラインに流し込む
- 合成データに含めるもの:
  - 会社メタデータ（株式会社アオバ製作所・架空住所・製造業・架空URL）
  - 会計CSV（12ヶ月分の取引データ）
  - カレンダーフィクスチャ（12ヶ月分。定例会議・1on1等）
  - communicationフィクスチャ（直接注入。Slack接続はOUTのため③の再現に使用）
  - attendanceフィクスチャ（勤怠データ。④の再現）
  - S0データ（e-Stat地域統計・gBizINFO・jGrants・競合サイト）
  - 稼働監視データ（追加陰性兼E3検証用サイトダウンイベント）
- 仕込み異常8件（スキル正本の番号①〜⑧に一致）:
  - ① 主要顧客の発注間隔が3ヶ月かけて伸長（傾向走査）
  - ② 入金予定日の未着1件（期日走査）
  - ③ 特定従業員の返信遅延が3週連続悪化（communicationフィクスチャ直接注入。乖離走査）
  - ④ 深夜残業の漸増・1名（attendanceフィクスチャ。傾向走査）
  - ⑤ 売上の季節性どおりの低下 = **陰性コントロール（検知したら即fail）**
  - ⑥ 新規問い合わせ比率の低下（乖離走査）
  - ⑦ 定例会議の消失（途絶走査）
  - ⑧ 競合サイトの採用ページ新設（外部着火走査）
- 陽性 = ①②③④⑥⑦⑧ の7件 / 陰性コントロール = ⑤ の1件
- D1/D2 の分母はこの8件（陽性7件中6件以上検知 / 誤検知≤2 / ⑤検知で即fail）
- 追加の陰性（E3検証用サイトダウン・祝日・天候）は歓迎。スキルファイルへの追記とセットで追加する

```typescript
// scripts/generate.ts（スキル正本のファイル名に合わせる）
interface SyntheticCompany {
  meta: {
    name: "株式会社アオバ製作所";
    address: string;
    industry: "manufacturing";
    url: string;
  };
  accounting_csv: string;
  calendar_fixtures: CalendarEvent[];
  communication_fixtures: CommunicationEvent[]; // ③返信遅延の再現用
  attendance_fixtures: AttendanceEvent[]; // ④深夜残業の再現用
  s0_data: S0DataSet;
  monitor_events: MonitorEvent[]; // 追加陰性兼E3用
  planted_signals: PlantedSignal[]; // ①〜⑧（⑤は陰性）
}
```

- [ ] **Step 1: 生成スクリプトのテストを書く**
- [ ] **Step 2: 合成会社生成ロジックを実装**
- [ ] **Step 3: ゴールデンセットを生成して eval/golden/ に配置**
- [ ] **Step 4: pnpm run eval:engine で D1-D2 を検証**
- [ ] **Step 5: コミット**

### Task 9.2: E2E テスト（Playwright）

**Files:**

- Create: `tests/e2e/registration-to-day0.spec.ts`

sprint-evaluator が使用する E2E テスト。
プレビュー環境で登録→Day0レポートのフローを検証。

---

## 実装順序（依存関係）

```
Phase 0: プロジェクト初期化
  └→ Phase 1: スキーマ（マイグレーション）
      └→ Phase 2: 共有契約（Zod）
          ├→ Phase 3: Ingest層（B基準）
          │   └→ Phase 4: State層（C基準）
          │       └→ Phase 5: Sense層（D基準）
          │           └→ Phase 6: Act層（E基準）
          │               └→ Phase 7: Day0統合（A基準）
          ├→ Phase 8: セキュリティ横断（F基準）← Phase 1と並行可
          └→ Phase 9: 合成会社＋統合テスト ← Phase 5以降
```

## TDD対象基準の一覧

| 基準  | テストファイル                                                           | テスト種別 |
| ----- | ------------------------------------------------------------------------ | ---------- |
| B1-B3 | `tests/unit/csv-parser.test.ts` + `tests/integration/ingest-csv.test.ts` | 単体＋統合 |
| B4    | `tests/integration/ingest-calendar.test.ts`                              | 統合       |
| B5    | `tests/unit/s0-ingest.test.ts`                                           | 単体       |
| B6    | `tests/unit/allowlist.test.ts`                                           | 単体       |
| C1    | `tests/unit/baselines.test.ts`                                           | 単体       |
| C2    | `tests/unit/company-summary.test.ts`                                     | 単体       |
| C3    | `tests/unit/memory-packet.test.ts`                                       | 単体       |
| D1-D2 | `tests/unit/scanner.test.ts` + `tests/eval/engine.test.ts`               | 単体＋eval |
| D3    | `tests/unit/evaluator.test.ts`                                           | 単体       |
| D4    | `tests/unit/scanner.test.ts` 内                                          | 単体       |
| D5    | 統合テスト内                                                             | 統合       |
| D6    | `tests/unit/finding-lifecycle.test.ts`                                   | 単体       |
| E1-E2 | `tests/unit/weekly-renderer.test.ts`                                     | 単体       |
| E3    | `tests/unit/alert-renderer.test.ts`                                      | 単体       |
| E4    | 統合テスト内                                                             | 統合       |
| E5    | `tests/unit/quiet-hours.test.ts`                                         | 単体       |
| F1    | `tests/unit/allowlist.test.ts` + 統合                                    | 単体＋統合 |
| F2    | `tests/integration/rls.test.ts`                                          | 統合       |
| F3    | `tests/integration/webhook-signature.test.ts`                            | 統合       |
| F4    | CI gitleaks-action                                                       | CI         |
| F5    | CI検査スクリプト                                                         | CI         |

## 07_open_items.md との境界

以下は本計画の**スコープ外**（07の未確定事項に該当）:

- プラン具体値（entitlement適用）
- オンボーダー採算モデル
- Phase3 横断パターンの匿名化設計
- Chatwork/freee口座明細/Square等のAPI・規約確認
- GBP API: 別プロジェクトか共用かの設計判断
- Instagramレート制限のアプリ/アカウント単位の確認
- SmartHR/Jobcan/MF勤怠の外部利用可否
- Supabaseプレビューブランチのcron/secrets/Vault再現範囲
