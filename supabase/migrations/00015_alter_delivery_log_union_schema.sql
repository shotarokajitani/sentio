-- 00015: delivery_log を和集合スキーマに拡張
-- 既存: id, company_id, frame, finding_ids, sent_at, opened, acted
-- 追加: channel, delivery_type, content, status, created_at
-- frame は delivery_type に統合（frame を DROP）

-- 新カラム追加
ALTER TABLE delivery_log ADD COLUMN IF NOT EXISTS channel TEXT;
ALTER TABLE delivery_log ADD COLUMN IF NOT EXISTS delivery_type TEXT;
ALTER TABLE delivery_log ADD COLUMN IF NOT EXISTS content JSONB DEFAULT '{}';
ALTER TABLE delivery_log ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'sent';
ALTER TABLE delivery_log ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

-- 既存データの frame → delivery_type マイグレーション
UPDATE delivery_log SET delivery_type = frame WHERE delivery_type IS NULL AND frame IS NOT NULL;

-- frame の CHECK 制約を削除してから DROP
-- (制約名は CREATE TABLE 時の暗黙名)
DO $$ BEGIN
  ALTER TABLE delivery_log DROP CONSTRAINT IF EXISTS delivery_log_frame_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE delivery_log DROP COLUMN IF EXISTS frame;

-- sent_at のデフォルトを変更（NOT NULL 制約を緩和 — Edge Functionはcreated_atを使う）
ALTER TABLE delivery_log ALTER COLUMN sent_at DROP NOT NULL;
ALTER TABLE delivery_log ALTER COLUMN sent_at DROP DEFAULT;
