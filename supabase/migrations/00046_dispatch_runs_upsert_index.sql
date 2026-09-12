-- 00046: pending の予約が本番で1行も書けていなかったのを直す（⑥J-4 の欠陥）
--
-- ## 何が起きていたか
--
-- 本番のログに毎朝これが出ていた（2026-09-12 の実測）。
--
--     dispatch: pending の予約に失敗:
--     there is no unique or exclusion constraint matching the ON CONFLICT
--     specification (42P10)
--
-- **00043 が張った一意索引が部分索引だったため**である。
--
--     CREATE UNIQUE INDEX uq_dispatch_runs_company_run
--       ON dispatch_runs (dispatch, run_key, company_id)
--       WHERE kind = 'company' AND run_key IS NOT NULL;
--
-- PostgREST の `upsert(onConflict: "dispatch,run_key,company_id")` は
-- **列名から制約を推論する。部分索引は推論できない。**
-- `ON CONFLICT (col, ...)` に `WHERE` 句を書かない限り、Postgres は
-- 部分索引を候補に入れないからである。
--
-- 結果、`dispatch_runs` に `run_key` を持つ行が**1行も入らなかった**
-- （本番50行中0件・同日の照会）。⑥J-4 の再開は**一度も動いていない。**
--
-- ## 既存行をどう扱うか
--
-- **消さない。埋めもしない。**
--
-- `kind='company'` の既存37行は `run_key` が NULL である。ここに
-- `created_at` から導いた日付を埋めると、**6組が重複し、最大5行が同じ組になる**
-- （同日の実測）。これは再開 cron が同じ会社を5回処理した跡そのもので、
-- **記録として残すべき事実**である。消して一意にするのは、起きたことを消すことになる。
--
-- 部分索引をやめて**通常の一意索引**にすれば、既存行はそのまま残せる。
-- Postgres の既定（NULLS DISTINCT）では **NULL を含む行は一意制約に当たらない**ので、
-- `run_key IS NULL` の37行は何行あってもよい。
--
-- `kind='run'` の行も同じ理由で影響を受けない（`company_id` が NULL）。
-- 00043 の自表検証がこれを確かめている。
--
-- **`NULLS NOT DISTINCT` は使わない。** 使うと既存行が衝突する。
--
-- ## 冪等性
--
-- DROP INDEX IF EXISTS → CREATE UNIQUE INDEX IF NOT EXISTS。再実行安全。

DROP INDEX IF EXISTS uq_dispatch_runs_company_run;

CREATE UNIQUE INDEX IF NOT EXISTS uq_dispatch_runs_company_run
  ON dispatch_runs (dispatch, run_key, company_id);

-- ---------------------------------------------------------------------------
-- 自表検証。**期待と違えば migration を失敗させる**
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_company UUID := '00000000-0000-0000-0000-0000000046a1';
  v_predicate TEXT;
BEGIN
  -- 1. **部分索引でないこと。** ここが今回の欠陥そのものである
  SELECT pg_get_expr(i.indpred, i.indrelid) INTO v_predicate
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  WHERE c.relname = 'uq_dispatch_runs_company_run';

  IF v_predicate IS NOT NULL THEN
    RAISE EXCEPTION '00046: 索引がまだ部分索引である（% ）。upsert が 42P10 になる', v_predicate;
  END IF;

  -- 2. **既存行を壊していないこと。** run_key が NULL の行が残っている
  IF NOT EXISTS (SELECT 1 FROM dispatch_runs WHERE run_key IS NULL) THEN
    RAISE WARNING '00046: run_key が NULL の行が1件も無い（新しいDBなら正常）';
  END IF;

  -- 3. 同じ (dispatch, run_key, company_id) は2行入らない
  INSERT INTO dispatch_runs (kind, dispatch, company_id, outcome, run_key)
  VALUES ('company', 'daily', v_company, 'pending', 'migration_self_check');
  BEGIN
    INSERT INTO dispatch_runs (kind, dispatch, company_id, outcome, run_key)
    VALUES ('company', 'daily', v_company, 'pending', 'migration_self_check');
    RAISE EXCEPTION '00046: 同じ会社・同じ run_key の行が2つ入った';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  -- 4. **run_key が NULL なら何行でも入る**（既存行を残すための前提）
  INSERT INTO dispatch_runs (kind, dispatch, company_id, outcome)
  VALUES ('company', 'daily', v_company, 'delivered');
  INSERT INTO dispatch_runs (kind, dispatch, company_id, outcome)
  VALUES ('company', 'daily', v_company, 'delivered');

  DELETE FROM dispatch_runs WHERE company_id = v_company;
END $$;
