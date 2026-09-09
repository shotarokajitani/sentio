-- 00040: sync-connections を UTC 0/6/12/18 から 2/8/14/20 へ移す（発注 A-4）
--
-- ## なぜ移すか
--
-- **UTC 0:00 は JST 9:00 で、KING OF TIME の禁止帯のど真ん中である。**
-- CLAUDE.md の絶対規則は「JST 8:30–10:00 / 17:30–18:30 に接続しない
-- （cron は UTC 02:00 以降）」で、`0 0,6,12,18` はこれを満たしていない。
--
-- `docs/checklists/cron-jobs.yml` の note は
-- 「UTC 02:00 以降という制約があり、この並びはそれを満たす」と書いていたが、
-- **満たしていなかった。** 宣言のほうが間違っていたので、宣言も直す。
--
--   旧 UTC 0  → JST  9:00   ← 禁止帯（8:30–10:00）
--   旧 UTC 6  → JST 15:00
--   旧 UTC 12 → JST 21:00
--   旧 UTC 18 → JST  3:00
--
--   新 UTC 2  → JST 11:00
--   新 UTC 8  → JST 17:00   ← 17:30 の手前で終わる
--   新 UTC 14 → JST 23:00
--   新 UTC 20 → JST  5:00
--
-- **6時間間隔は変えない。** 変えるのは起点だけである。
--
-- ## 触らないもの
--
-- `dispatch-daily`（UTC 22:00）/ `dispatch-weekly`（日曜 UTC 23:00）/
-- `retention-purge`（UTC 20:00）は**変えない**。
-- KING OF TIME に触るのは `sync-connections` だけである。
--
-- ## 本文は作り直さない
--
-- `cron.schedule(name, schedule, command)` は同名を上書きするので、
-- **いま登録されている本文をそのまま読み出して、時刻だけ差し替える。**
-- 本文を書き直すと 00020 の Vault 経由の秘密取得を写し間違える危険がある。
--
-- ## 冪等性
--
-- 既存ジョブの command を読んで再登録するだけ。再実行安全。

DO $$
DECLARE
  v_command TEXT;
BEGIN
  SELECT command INTO v_command FROM cron.job WHERE jobname = 'sync-connections';

  IF v_command IS NULL THEN
    -- **無いものを作らない。** 00020 が登録しているはずで、無いなら前提が崩れている
    RAISE EXCEPTION '00040: cron.job に sync-connections が無い（00020 の前提が崩れている）';
  END IF;

  PERFORM cron.schedule('sync-connections', '0 2,8,14,20 * * *', v_command);
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
  FROM cron.job WHERE jobname = 'sync-connections';

  IF v_schedule <> '0 2,8,14,20 * * *' THEN
    RAISE EXCEPTION '00040: sync-connections の schedule が % のまま', v_schedule;
  END IF;

  -- **本文が空になっていないこと。** 読み出しに失敗したまま登録すると連携が止まる
  IF v_command IS NULL OR position('/functions/v1/sync-connections' in v_command) = 0 THEN
    RAISE EXCEPTION '00040: sync-connections の本文が壊れている';
  END IF;

  -- **他の3本を巻き込んでいないこと**
  IF (SELECT schedule FROM cron.job WHERE jobname = 'dispatch-daily') <> '0 22 * * *' THEN
    RAISE EXCEPTION '00040: dispatch-daily の schedule を変えてしまった';
  END IF;
  IF (SELECT schedule FROM cron.job WHERE jobname = 'dispatch-weekly') <> '0 23 * * 0' THEN
    RAISE EXCEPTION '00040: dispatch-weekly の schedule を変えてしまった';
  END IF;
  IF (SELECT schedule FROM cron.job WHERE jobname = 'retention-purge') <> '0 20 * * *' THEN
    RAISE EXCEPTION '00040: retention-purge の schedule を変えてしまった';
  END IF;
END $$;
