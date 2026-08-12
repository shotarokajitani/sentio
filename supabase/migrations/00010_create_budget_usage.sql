-- 00010: budget_usage テーブル
-- LLM予算使用量の日次トラッキング

CREATE TABLE IF NOT EXISTS budget_usage (
  company_id UUID NOT NULL,
  date       DATE NOT NULL,
  full_runs  INT NOT NULL DEFAULT 0,
  light_runs INT NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, date)
);

ALTER TABLE budget_usage ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "users_own_budget_usage" ON budget_usage FOR ALL
    USING (company_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
