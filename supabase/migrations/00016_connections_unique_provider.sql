-- 00016: connections テーブルに (company_id, provider) ユニーク制約追加
-- OAuth コールバックでの upsert に必要

CREATE UNIQUE INDEX IF NOT EXISTS idx_connections_company_provider
  ON connections(company_id, provider);
