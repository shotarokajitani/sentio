-- 00013: RLS有効化アサーション
-- 全publicテーブルでRLSが有効であることを検証

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('connector_limits')
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = r.tablename AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'RLS not enabled on table: %', r.tablename;
    END IF;
  END LOOP;
END;
$$;
