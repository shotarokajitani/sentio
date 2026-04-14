-- sync-ga4-data を毎日 UTC 2:00 に実行
-- GA4 連携済みの全社を対象にバッチで同期する。
-- project_url / service_role_key は Supabase dashboard の Vault から取得する前提。

SELECT cron.schedule(
  'daily-sync-ga4',
  '0 2 * * *',
  $$
  SELECT
    net.http_post(
      url := 'https://kwpldqbnkraftaahnpev.supabase.co/functions/v1/sync-ga4-data',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || current_setting('app.service_role_key', true)
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    ) AS request_id;
  $$
);
