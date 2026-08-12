-- 00007: connections + connector_limits テーブル
-- データソース接続管理（トークンはVaultのみ）

CREATE TABLE IF NOT EXISTS connections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL,
  provider        TEXT NOT NULL,
  vault_secret_id UUID,
  scopes          TEXT[] DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'pending',
  last_refresh    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_connections_company
  ON connections(company_id);

ALTER TABLE connections ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "users_own_connections" ON connections FOR ALL
    USING (company_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- connector_limits: 共有テーブル（レート制限レジストリ）
CREATE TABLE IF NOT EXISTS connector_limits (
  provider TEXT PRIMARY KEY,
  limits   JSONB DEFAULT '{}'
);

ALTER TABLE connector_limits ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "connector_limits_read_all" ON connector_limits FOR SELECT
    USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
