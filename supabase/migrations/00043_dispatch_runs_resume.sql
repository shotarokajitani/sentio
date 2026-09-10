-- 00043: 配信を途中から再開できるようにする（発注 ⑥J-4 前倒し）
--
-- ## なぜ要るか
--
-- `dispatch-daily` は**全社を1回のリクエストで回している。** 記録を書くのは
-- 全部終わったあとなので、**時間切れで落ちると「誰が未処理か」がどこにも残らない。**
-- 翌朝の実行は最初からやり直すが、そこでも落ちれば同じことが起きる。
--
-- 会社が増えるほど落ちやすくなり、**増えたぶんだけ後ろの会社が届かなくなる。**
--
-- ## 何を足すか
--
--   run_key      その実行が対象にしている期間（daily は JST 日付、weekly は ISO 週）
--   started_at   会社ごとの処理を始めた時刻
--   finished_at  終わった時刻。**NULL のまま残っていれば、落ちた場所が分かる**
--
-- `outcome` に `pending` / `running` / `timeout` を足す。**新しい列は作らない**——
-- 「結末」を入れる列は既にあり、2つ持つと**どちらが本当かが分からなくなる。**
--
-- ## 一意にする範囲
--
-- `(dispatch, run_key, company_id)` に一意索引を張る。これで
--
--   1. pending の先出しが**冪等**になる（再実行しても増えない）
--   2. 再開が「まだ pending / timeout の行」だけを拾える
--
-- `kind = 'company'` の行だけを対象にする。`kind = 'run'` は会社ごとではないので
-- `company_id` が NULL であり、一意索引に入れると1日1行しか書けなくなる。
--
-- ## 冪等性
--
-- ADD COLUMN IF NOT EXISTS / CREATE UNIQUE INDEX IF NOT EXISTS /
-- DROP CONSTRAINT IF EXISTS → ADD CONSTRAINT のみ。再実行安全。

ALTER TABLE dispatch_runs ADD COLUMN IF NOT EXISTS run_key TEXT;
ALTER TABLE dispatch_runs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE dispatch_runs ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;

-- **既存行は run_key を持たない。** 一意索引に入れないよう部分索引にする
CREATE UNIQUE INDEX IF NOT EXISTS uq_dispatch_runs_company_run
  ON dispatch_runs (dispatch, run_key, company_id)
  WHERE kind = 'company' AND run_key IS NOT NULL;

-- 未処理を引くための索引。**再開が毎回全表を舐めないようにする**
CREATE INDEX IF NOT EXISTS idx_dispatch_runs_unfinished
  ON dispatch_runs (dispatch, run_key)
  WHERE kind = 'company' AND finished_at IS NULL;

ALTER TABLE dispatch_runs DROP CONSTRAINT IF EXISTS dispatch_runs_outcome_check;
ALTER TABLE dispatch_runs ADD CONSTRAINT dispatch_runs_outcome_check
  CHECK (outcome IS NULL OR outcome IN (
    -- **まだ手を付けていない**（先に書いておく行）。落ちても残る
    'pending',
    -- 呼び出しに入った。ここで落ちた行は `finished_at` が NULL のまま残る
    'running',
    -- 90秒で返ってこなかった。**「送れなかった」と「返事が無い」を分ける**
    'timeout',
    'delivered', 'reconnect_notice', 'reconnect_suppressed',
    'skipped_no_connection', 'skipped_no_email',
    'skipped_not_entitled', 'skipped_ended',
    'failed_state', 'failed_sense', 'failed_deliver',
    'packet_delivered', 'packet_not_sent', 'packet_build_failed'
  ));

-- ---------------------------------------------------------------------------
-- 自表検証。**期待と違えば migration を失敗させる**
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  c TEXT;
  v_i INT := 0;
  v_company UUID := '00000000-0000-0000-0000-00000000000f';
BEGIN
  FOREACH c IN ARRAY ARRAY['run_key', 'started_at', 'finished_at'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'dispatch_runs' AND column_name = c
    ) THEN
      RAISE EXCEPTION '00043: dispatch_runs.% が無い', c;
    END IF;
  END LOOP;

  -- 新しい3値が通ること。
  -- **会社を分ける。** 同じ会社で3回入れると、いま張ったばかりの
  -- `uq_dispatch_runs_company_run` に自分で当たる（2026-09-10 に CI で実測:
  -- `duplicate key value violates unique constraint` SQLSTATE 23505）
  FOREACH c IN ARRAY ARRAY['pending', 'running', 'timeout'] LOOP
    v_i := v_i + 1;
    BEGIN
      INSERT INTO dispatch_runs (kind, dispatch, company_id, outcome, run_key)
      VALUES ('company', 'daily',
              ('00000000-0000-0000-0000-00000000000' || v_i::text)::uuid,
              c, 'migration_self_check');
    EXCEPTION WHEN check_violation THEN
      RAISE EXCEPTION '00043: outcome に % を入れられない', c;
    END;
  END LOOP;

  -- **同じ (dispatch, run_key, company_id) は2行入らないこと**（先出しの冪等）
  INSERT INTO dispatch_runs (kind, dispatch, company_id, outcome, run_key)
  VALUES ('company', 'daily', v_company, 'pending', 'migration_self_check');
  BEGIN
    INSERT INTO dispatch_runs (kind, dispatch, company_id, outcome, run_key)
    VALUES ('company', 'daily', v_company, 'pending', 'migration_self_check');
    RAISE EXCEPTION '00043: 同じ会社・同じ run_key の行が2つ入った';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  -- **`kind = run` は一意索引の対象外**であること（1日1行しか書けなくならない）
  INSERT INTO dispatch_runs (kind, dispatch, companies, run_key)
  VALUES ('run', 'daily', 0, 'migration_self_check');
  INSERT INTO dispatch_runs (kind, dispatch, companies, run_key)
  VALUES ('run', 'daily', 0, 'migration_self_check');

  DELETE FROM dispatch_runs WHERE run_key = 'migration_self_check';

  -- 既存の値が通り続けること（**止めるつもりが無いものを止めない**）
  FOREACH c IN ARRAY ARRAY['delivered', 'skipped_no_connection', 'packet_delivered'] LOOP
    BEGIN
      INSERT INTO dispatch_runs (kind, dispatch, company_id, outcome)
      VALUES ('company', 'daily', v_company, c);
      DELETE FROM dispatch_runs WHERE company_id = v_company AND outcome = c;
    EXCEPTION WHEN check_violation THEN
      RAISE EXCEPTION '00043: 既存の outcome % が通らなくなった', c;
    END;
  END LOOP;
END $$;
