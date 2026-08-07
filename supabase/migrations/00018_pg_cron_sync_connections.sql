-- 00018: pg_cron で sync-connections を定期実行
-- 間隔: 6時間（UTC 00:00, 06:00, 12:00, 18:00）
--
-- Why 6時間:
--   - Google access_tokenは1時間で失効するが、リフレッシュはsync実行時に
--     オンデマンドで行われるため、6時間以内にリフレッシュされれば十分
--   - freee access_tokenは24時間で失効するため6時間間隔で余裕あり
--   - Sentioのscanは日次バッチのため、同期頻度を上げてもsense層には影響しない
--   - 15分間隔だとGoogle Calendar APIのレート制限（100万req/日・プロジェクト単位）に
--     接続数×4回/時で圧迫する。6時間間隔なら1日4回で十分安全
--   - KING OF TIME制約（JST 8:30-10:00接続禁止）は現時点では対象外だが、
--     将来の勤怠コネクタ追加時にcron時刻の見直しが必要

SELECT cron.schedule(
  'sync-connections',
  '0 0,6,12,18 * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/sync-connections',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
