-- 00009: delivery_log テーブル
-- 配信ログ（どのフレームでいつ何を送ったか）

CREATE TABLE IF NOT EXISTS delivery_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL,
  frame       TEXT NOT NULL CHECK (frame IN ('day0','pulse','alert','weekly','radar')),
  finding_ids UUID[] DEFAULT '{}',
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  opened      BOOLEAN NOT NULL DEFAULT false,
  acted       BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_delivery_log_company
  ON delivery_log(company_id);

ALTER TABLE delivery_log ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "users_own_delivery_log" ON delivery_log FOR ALL
    USING (company_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
