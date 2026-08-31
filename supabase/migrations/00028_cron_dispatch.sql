-- 00028: 配信ディスパッチャの cron を2本張る（契約 docs/contracts/slice-cron-dispatch.md）
--
-- 背景:
--   cron.schedule が張られているのは sync-connections の1本だけだった（00020）。
--   run-sense / deliver-pulse / deliver-weekly は手で叩かないと動かず、
--   **取り込みだけが自動で、判断と配信が手動**という逆立ちした状態だった。
--
--   cron から deliver-* を直接叩くことはできない（2026-08-31 実測）。
--   deliver-pulse も deliver-weekly も email が必須で、無ければ 400 を返す。
--   cron の本文は body := '{}'::jsonb を投げるだけなので、
--   そのまま張れば**毎日 400 が積み上がるだけで誰も気づかない**。
--   したがって、あいだにディスパッチャを置く（CD-D2）。
--
-- 実行時刻（CD-D5）:
--   dispatch-daily   UTC 22:00      = JST 翌 07:00
--   dispatch-weekly  UTC 日曜 23:00 = JST 月曜 08:00
--   どちらも KING OF TIME の禁止帯（JST 8:30–10:00 / 17:30–18:30）に掛からない。
--
-- 00020 との関係:
--   ジョブ名を分けている。sync-connections のジョブは**書き換えない**（CD-4-2）。
--   秘密の取得は 00020 と同じ read_vault_secret_by_name 経由で、
--   **秘密の値はこのファイルにもログにも現れない**（CD-4-4）。
--
-- 冪等性: cron.schedule は同名ジョブを上書きする。再実行安全。

DO $$
DECLARE
  -- シークレット名の正本は 00020 と同じ。ここで別名を作ると登録手順書と割れる
  c_secret_url CONSTANT TEXT := 'sentio_supabase_url';
  c_secret_key CONSTANT TEXT := 'sentio_service_role_key';

  v_daily   TEXT;
  v_weekly  TEXT;
BEGIN
  -- cron 本文は pg_cron が保存した文字列をそのまま実行する。
  -- search_path に依存しないよう、関数はスキーマ修飾する（00020 と同じ作法）
  v_daily := format($cmd$
    SELECT net.http_post(
      url := public.read_vault_secret_by_name(%L) || '/functions/v1/dispatch-daily',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || public.read_vault_secret_by_name(%L),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb
    );
  $cmd$, c_secret_url, c_secret_key);

  v_weekly := format($cmd$
    SELECT net.http_post(
      url := public.read_vault_secret_by_name(%L) || '/functions/v1/dispatch-weekly',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || public.read_vault_secret_by_name(%L),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb
    );
  $cmd$, c_secret_url, c_secret_key);

  PERFORM cron.schedule('dispatch-daily', '0 22 * * *', v_daily);
  PERFORM cron.schedule('dispatch-weekly', '0 23 * * 0', v_weekly);
END;
$$;
