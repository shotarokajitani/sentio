-- 00006: findings テーブル
-- Sense層の出力（発見・洞察・アラート）

CREATE TABLE IF NOT EXISTS findings (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('open','watching','resolved','expired')),
  urgency            TEXT NOT NULL CHECK (urgency IN ('immediate','weekly','monthly')),
  what               TEXT NOT NULL,
  evidence_event_ids TEXT[] DEFAULT '{}',
  confidence         NUMERIC NOT NULL DEFAULT 0,
  hypotheses         JSONB DEFAULT '{}',
  next_actions       JSONB DEFAULT '{}',
  eval_log           JSONB DEFAULT '{}',
  parent_finding_id  UUID REFERENCES findings(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_findings_company
  ON findings(company_id);

CREATE INDEX IF NOT EXISTS idx_findings_status
  ON findings(company_id, status);

ALTER TABLE findings ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "users_own_findings" ON findings FOR ALL
    USING (company_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
