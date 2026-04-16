-- 月次損益データの保存テーブル。
-- CSV（freee/マネーフォワード/弥生）・PDF（決算書・試算表）から抽出した
-- 月次の売上・粗利・固定費・営業利益を格納する。
-- 生のCSV/PDFは保存せず、数値だけをここに残す。

CREATE TABLE IF NOT EXISTS financials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  year_month text NOT NULL,                 -- 'YYYY-MM' 形式
  revenue numeric,                          -- 売上高（円）
  gross_profit numeric,                     -- 粗利（売上総利益）
  fixed_cost numeric,                       -- 固定費（販管費として扱う）
  operating_profit numeric,                 -- 営業利益
  source text NOT NULL DEFAULT 'csv',       -- 'csv' または 'pdf'
  created_at timestamptz DEFAULT now(),
  UNIQUE (company_id, year_month)
);

CREATE INDEX IF NOT EXISTS idx_financials_company_month
  ON financials(company_id, year_month);

-- RLS: 経営者は自社分のみ全操作可能。service_role は RLS バイパスで書き込み。
ALTER TABLE financials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own financials" ON financials;
CREATE POLICY "own financials" ON financials
  USING (company_id IN (
    SELECT id FROM companies WHERE user_id = auth.uid()
  ));

NOTIFY pgrst, 'reload schema';
