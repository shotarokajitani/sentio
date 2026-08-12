-- 00008: known_explanations テーブル
-- 既知の説明（祝日・繁忙期等、誤検知抑制用）

CREATE TABLE IF NOT EXISTS known_explanations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID,
  kind       TEXT NOT NULL,
  period     TEXT NOT NULL,
  source     TEXT NOT NULL,
  auto       BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_known_explanations_company
  ON known_explanations(company_id);

ALTER TABLE known_explanations ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "users_own_known_explanations" ON known_explanations FOR ALL
    USING (company_id = auth.uid() OR company_id IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
