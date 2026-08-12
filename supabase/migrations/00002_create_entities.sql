-- 00002: entities テーブル
-- 会社モデルの構成要素（従業員・取引先・プロジェクト等）

CREATE TABLE IF NOT EXISTS entities (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL,
  type           TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  merge_keys     JSONB DEFAULT '{}',
  attrs          JSONB DEFAULT '{}',
  care_only      BOOLEAN NOT NULL DEFAULT true,
  first_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_entities_company
  ON entities(company_id);

ALTER TABLE entities ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "users_own_entities" ON entities FOR ALL
    USING (company_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
