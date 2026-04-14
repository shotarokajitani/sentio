-- 【1】pg_cron死活監視テーブル
CREATE TABLE IF NOT EXISTS cron_job_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name text NOT NULL,
  started_at timestamptz DEFAULT now(),
  finished_at timestamptz,
  status text DEFAULT 'running',
  error_message text,
  records_processed integer DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_cron_job_logs_job_name
  ON cron_job_logs(job_name);
CREATE INDEX IF NOT EXISTS idx_cron_job_logs_started_at
  ON cron_job_logs(started_at DESC);

-- 【2】signalsテーブルの検索高速化
CREATE INDEX IF NOT EXISTS idx_signals_company_id ON signals(company_id);
CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals(created_at);
CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status);
CREATE INDEX IF NOT EXISTS idx_signals_pattern_id ON signals(pattern_id);

-- 【5】30日間オンボーディングメール重複防止テーブル
CREATE TABLE IF NOT EXISTS notification_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
  day integer NOT NULL,
  sent_at timestamptz DEFAULT now(),
  UNIQUE(company_id, day)
);

CREATE INDEX IF NOT EXISTS idx_notification_logs_company_id
  ON notification_logs(company_id);

NOTIFY pgrst, 'reload schema';
