-- 00004: narratives テーブル
-- 会社の文脈記憶（カテゴリ別トピック）

CREATE TABLE IF NOT EXISTS narratives (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID NOT NULL,
  category          TEXT NOT NULL,
  topic             TEXT NOT NULL,
  content           TEXT NOT NULL,
  confidence        NUMERIC NOT NULL DEFAULT 0,
  source_event_ids  TEXT[] DEFAULT '{}',
  last_confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decayed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_narratives_company
  ON narratives(company_id);

ALTER TABLE narratives ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "users_own_narratives" ON narratives FOR ALL
    USING (company_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
