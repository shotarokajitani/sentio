-- 00014: ロール別テーブル権限付与
-- service_role: 全テーブルに CRUD（Edge Function / バックエンド用）
-- authenticated: 自社データの読み取り（RLSで制御）
-- anon: S0データの読み取り（RLSで制御）

-- スキーマ使用権限（supabase db reset 時に必要）
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO service_role;

-- service_role — 全テーブルに全操作
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;

-- authenticated — 読み取り + 限定的な書き込み（RLSが制御）
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;

-- anon — 読み取りのみ（RLSが制御）
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;

-- 今後作成されるテーブルにもデフォルトで適用
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO anon;
