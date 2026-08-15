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
--
-- 列存在ガードで包む理由: 下の DROP COLUMN IF EXISTS frame と対になっているため、
-- ガード無しだと2回目の適用が `column "frame" does not exist` で失敗する
-- （00001〜00018で唯一の非冪等箇所だった）。
-- frame が既に無い＝移行済みなので、その場合は正しく no-op になる。
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'delivery_log' AND column_name = 'frame'
  ) THEN
    UPDATE delivery_log SET delivery_type = frame
    WHERE delivery_type IS NULL AND frame IS NOT NULL;
  END IF;
END $$;

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
