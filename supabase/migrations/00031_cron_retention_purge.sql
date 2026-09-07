-- 00031: retention-purge の cron を張る（契約D の A-2 / 発注2）
--
-- ## なぜディスパッチャに相乗りさせないか
--
-- `dispatch-daily` を挟んだのは、`deliver-*` が **email 必須**で cron の
-- `'{}'::jsonb` では 400 になるからだった（CD-D2）。
-- **`retention-purge` は会社ごとの引数を取らない**（自分で全社を列挙する）。
-- したがってその理由が当てはまらず、直接叩いてよい。
-- 相乗りさせると、配信の失敗で削除が止まる／削除の失敗で配信が止まるという
-- **無関係な結合**が生まれる。
--
-- ## 実行時刻
--
-- UTC 20:00 = JST 翌 05:00。**毎朝のパルス（UTC 22:00）より前**に置く。
-- KING OF TIME の禁止帯（JST 8:30–10:00 / 17:30–18:30）にも掛からない。
--
-- ## **既定は数えるだけ（dry_run: true）**
--
-- 本番の実削除は、DRY-RUN の結果を人間が見てから可否を出す（発注2 の 1-5）。
-- **cron を張ることと、実削除を始めることは別である。** ここでは前者だけを行う。
-- 実削除に切り替えるときは、この本文を `{"dry_run": false}` に変える migration を
-- 別に立てる（CI/CD 経由。**Dashboard で手で書き換えない**）。
--
-- 秘密の取得は 00020 / 00028 と同じ read_vault_secret_by_name 経由で、
-- **秘密の値はこのファイルにもログにも現れない**。
--
-- 冪等性: cron.schedule は同名ジョブを上書きする。再実行安全。

DO $$
DECLARE
  c_secret_url CONSTANT TEXT := 'sentio_supabase_url';
  c_secret_key CONSTANT TEXT := 'sentio_service_role_key';

  v_command TEXT;
BEGIN
  v_command := format($cmd$
    SELECT net.http_post(
      url := public.read_vault_secret_by_name(%L) || '/functions/v1/retention-purge',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || public.read_vault_secret_by_name(%L),
        'Content-Type', 'application/json'
      ),
      body := '{"dry_run": true}'::jsonb
    );
  $cmd$, c_secret_url, c_secret_key);

  PERFORM cron.schedule('retention-purge', '0 20 * * *', v_command);

  RAISE NOTICE '00031: cron retention-purge を UTC 20:00（JST 05:00）に張った（dry_run: true）';
END $$;

-- 張ったことを実物で確かめる。**宣言（docs/checklists/cron-jobs.yml）との突合は
-- `check:cron-jobs` が CI で行う。**ここでは存在と時刻だけを見る
DO $$
DECLARE
  v_schedule TEXT;
BEGIN
  SELECT schedule INTO v_schedule FROM cron.job WHERE jobname = 'retention-purge';

  IF v_schedule IS NULL THEN
    RAISE EXCEPTION '00031: cron.job に retention-purge が無い';
  END IF;

  IF v_schedule <> '0 20 * * *' THEN
    RAISE EXCEPTION '00031: retention-purge の時刻が % になっている（0 20 * * * が正）', v_schedule;
  END IF;
END $$;
