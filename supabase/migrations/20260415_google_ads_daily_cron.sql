-- sync-google-ads-data を毎日 UTC 2:30 に実行
-- Google広告連携済みの全社を対象にバッチで同期する。
-- Edge Functionは --no-verify-jwt でデプロイ済みのため Authorizationヘッダー不要。
-- 既存の weekly-summary-email / daily-onboarding-mail と同じパターン。

SELECT cron.unschedule('daily-sync-google-ads')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-sync-google-ads');

SELECT cron.schedule(
  'daily-sync-google-ads',
  '30 2 * * *',
  $$
  SELECT net.http_post(
    url := 'https://kwpldqbnkraftaahnpev.supabase.co/functions/v1/sync-google-ads-data',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
