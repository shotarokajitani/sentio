-- 00003: baselines テーブル
-- メトリクスの基準値（正常範囲の学習結果）

CREATE TABLE IF NOT EXISTS baselines (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL,
  metric_key     TEXT NOT NULL,
  entity_id      UUID,
  granularity    TEXT NOT NULL,
  stats          JSONB DEFAULT '{}',
  min_obs        INT NOT NULL DEFAULT 0,
  is_established BOOLEAN NOT NULL DEFAULT false,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_baselines_company
  ON baselines(company_id);

ALTER TABLE baselines ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "users_own_baselines" ON baselines FOR ALL
    USING (company_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
