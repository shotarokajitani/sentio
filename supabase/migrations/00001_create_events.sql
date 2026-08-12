-- 00001: events テーブル
-- イベントエンベロープ（全データ源の統一形式）

CREATE TABLE IF NOT EXISTS events (
  event_id     TEXT PRIMARY KEY,
  company_id   UUID,
  occurred_at  TIMESTAMPTZ NOT NULL,
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_event_id
  ON events(event_id);

CREATE INDEX IF NOT EXISTS idx_events_company_occurred
  ON events(company_id, occurred_at);

ALTER TABLE events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "users_own_events" ON events FOR ALL
    USING (company_id = auth.uid() OR company_id IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
