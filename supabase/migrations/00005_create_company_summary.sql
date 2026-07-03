-- 00005: company_summary テーブル
-- 会社全体の要約（LLMコンテキスト用）

CREATE TABLE IF NOT EXISTS company_summary (
  company_id   UUID PRIMARY KEY,
  content      TEXT NOT NULL DEFAULT '',
  token_count  INT NOT NULL DEFAULT 0,
  chapters     JSONB DEFAULT '{}',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE company_summary ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "users_own_company_summary" ON company_summary FOR ALL
    USING (company_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
