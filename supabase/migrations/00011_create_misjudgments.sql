-- 00011: misjudgments テーブル
-- 誤判定の追跡（フィードバックループ用）

CREATE TABLE IF NOT EXISTS misjudgments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  finding_id UUID NOT NULL REFERENCES findings(id),
  kind       TEXT NOT NULL,
  detail     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_misjudgments_company
  ON misjudgments(company_id);

ALTER TABLE misjudgments ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "users_own_misjudgments" ON misjudgments FOR ALL
    USING (company_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
