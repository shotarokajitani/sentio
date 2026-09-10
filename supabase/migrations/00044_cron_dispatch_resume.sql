-- 00044: 未処理の会社を拾い直す cron を足す（発注 ⑥J-4）
--
-- ## なぜ要るか
--
-- `dispatch-daily` は UTC 22:00 の1回だけである。**そこで落ちたら翌日まで届かない。**
-- 00043 で `pending` を先に書くようにしたので「誰が未処理か」は残るが、
-- **拾い直す口が無ければ残ったままである。**
--
-- 22:15 / 22:30 / 22:45 / 23:00 の4回、同じ `dispatch-daily` を叩く。
-- 関数は `run_key`（JST 日付）で当日ぶんを引き、**まだ終わっていない会社だけ**を回す。
-- 全部終わっていれば0社で即座に返るので、空振りは安い。
--
-- ## なぜ同じ関数を叩くのか
--
-- 再開専用の関数を作らない。**2つあると、片方だけ直す事故が起きる。**
-- `runDispatch` が再入可能になっているので、同じ入口で足りる。
--
-- 既に `delivered` の会社は `finished_at` が入っているため拾われない。
-- **2通目は出ない**（`delivery_log` の冪等キーもあるので二重の守りになる）。
--
-- ## 週次を再開しない理由
--
-- `dispatch-weekly` は日曜 UTC 23:00 の1本で、翌週まで6日ある。
-- **落ちたら人が気づいて手で叩ける時間がある。** 毎朝のパルスと違い、
-- 15分刻みで追いかける必要が無い。要ると分かってから足す。
--
-- ## 冪等性
--
-- cron.schedule は同名ジョブを上書きする。再実行安全。

DO $$
DECLARE
  c_secret_url CONSTANT TEXT := 'sentio_supabase_url';
  c_secret_key CONSTANT TEXT := 'sentio_service_role_key';
  v_command TEXT;
BEGIN
  -- 本文は 00028 の `dispatch-daily` と同じ。**同じ入口を叩く**
  v_command := format($cmd$
    SELECT net.http_post(
      url := public.read_vault_secret_by_name(%L) || '/functions/v1/dispatch-daily',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || public.read_vault_secret_by_name(%L),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb
    );
  $cmd$, c_secret_url, c_secret_key);

  PERFORM cron.schedule('dispatch-daily-resume', '15,30,45 22 * * *', v_command);
  PERFORM cron.schedule('dispatch-daily-resume-last', '0 23 * * *', v_command);
END;
$$;

-- ---------------------------------------------------------------------------
-- 自表検証。**期待と違えば migration を失敗させる**
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_schedule TEXT;
  v_command  TEXT;
BEGIN
  SELECT schedule, command INTO v_schedule, v_command
  FROM cron.job WHERE jobname = 'dispatch-daily-resume';

  IF v_schedule <> '15,30,45 22 * * *' THEN
    RAISE EXCEPTION '00044: dispatch-daily-resume の schedule が % である', coalesce(v_schedule, 'NULL');
  END IF;
  IF v_command IS NULL OR position('/functions/v1/dispatch-daily' in v_command) = 0 THEN
    RAISE EXCEPTION '00044: dispatch-daily-resume の本文が壊れている';
  END IF;

  SELECT schedule INTO v_schedule FROM cron.job WHERE jobname = 'dispatch-daily-resume-last';
  IF v_schedule <> '0 23 * * *' THEN
    RAISE EXCEPTION '00044: dispatch-daily-resume-last の schedule が % である', coalesce(v_schedule, 'NULL');
  END IF;

  -- **本体を巻き込んでいないこと**
  IF (SELECT schedule FROM cron.job WHERE jobname = 'dispatch-daily') <> '0 22 * * *' THEN
    RAISE EXCEPTION '00044: dispatch-daily の schedule を変えてしまった';
  END IF;
  IF (SELECT schedule FROM cron.job WHERE jobname = 'dispatch-weekly') <> '0 23 * * 0' THEN
    RAISE EXCEPTION '00044: dispatch-weekly の schedule を変えてしまった';
  END IF;
END $$;
