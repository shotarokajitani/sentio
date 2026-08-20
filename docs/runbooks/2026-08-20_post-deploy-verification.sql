-- 適用後確認: 00023 / 00024 が本番に正しく載ったか（2026-08-20 deploy #27 の事後検証）
--
-- 実行者: 人間（Supabase Dashboard > SQL Editor）
-- 本クエリは読み取り専用（SELECT のみ）。DDL・DML を含まず、秘密の値も返さない。
-- 実行タイミング: deploy #27（run 32336384906）完了後。すでに完了している。
--
-- **なぜこれが要るのか。**
-- 契約の受入基準は「00023 の server_version NOTICE と、00024 の移行行数 NOTICE が
-- 0行であることを deploy ログから引用する」だった。ところが `supabase db push` は
-- サーバ側の NOTICE を一切出力しない。実測した deploy ログの `Apply migrations` は
-- 全17行で、NOTICE は1行も含まれていなかった。**計器が存在しない。**
-- したがって同じことを SQL で確かめ直す。
--
-- 期待結果: Q1〜Q4 のすべてで verdict = 'OK'。
-- 1つでも 'NG' があれば、その行を添えて報告し、先に進まないこと。

-- ============================================================
-- Q1. 本番の PostgreSQL バージョン（00023:38 の NOTICE の代替）
-- ============================================================
-- 期待: server_version_num >= 150000。停止点0 の実測は 17.6。
-- 00023 の版ガード（server_version_num < 150000 で RAISE EXCEPTION）が
-- 発火せずに適用が成功した以上、15 以上であることは確定している。
-- ここでは値そのものを記録用に採る。

SELECT
  'Q1' AS q,
  'PostgreSQL バージョン' AS item,
  current_setting('server_version')     AS value,
  current_setting('server_version_num') AS value_num,
  CASE WHEN current_setting('server_version_num')::int >= 150000
       THEN 'OK' ELSE 'NG' END AS verdict;

-- ============================================================
-- Q2. 00023 の索引（00023:82 の NOTICE の代替）
-- ============================================================
-- 期待: idx_baselines_natural_key が実在し、UNIQUE であること。
-- 列集合は (company_id, metric_key, entity_id, granularity)。
-- 列の順序は UNIQUE の意味論にも ON CONFLICT の推論にも影響しないので、
-- 集合として一致していれば OK とする。

-- 定義文字列をそのまま出す。indkey を unnest する書き方は int2vector の扱いが
-- 環境で変わるため使わない（このSQLはローカルDBが無く実行検証できていない。
-- 壊れにくい書き方を優先する）。

SELECT
  'Q2' AS q,
  i.relname                AS index_name,
  ix.indisunique           AS is_unique,
  ix.indnullsnotdistinct   AS nulls_not_distinct,
  pg_get_indexdef(i.oid)   AS definition,
  CASE WHEN ix.indisunique AND ix.indnullsnotdistinct
       THEN 'OK' ELSE 'NG' END AS verdict
FROM pg_index ix
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_class t ON t.oid = ix.indrelid
WHERE t.relname = 'baselines'
  AND i.relname = 'idx_baselines_natural_key';

-- 0行が返ったら NG（索引が作られていない）。
-- indnullsnotdistinct = true が要点。false だと entity_id が NULL の行を
-- 一意制約が捕まえられず、自然キーの意味が成立しない。

-- ============================================================
-- Q3. 00024 の移行行数（00024:41 / :108 の NOTICE の代替）
-- ============================================================
-- 期待: **すべて 0**。
-- 停止点0 の実測（docs/checklists/env-diff.md）で delivery_log は 0行、
-- うち alert_deferred も 0 だった。したがって移行対象は0件でなければならない。
--
-- **0 以外が出た場合は、実測時点（2026-08-20）から本番データが動いたということ。**
-- その場で止めて報告すること。移行が正しく行われたかを個別に確認する必要がある。

SELECT
  'Q3' AS q,
  (SELECT count(*) FROM delivery_log)                                  AS total_rows,
  (SELECT count(*) FROM delivery_log WHERE delivery_type = 'alert_deferred') AS still_alert_deferred,
  (SELECT count(*) FROM delivery_log WHERE status IS NULL)             AS status_null,
  CASE WHEN (SELECT count(*) FROM delivery_log) = 0
       THEN 'OK（0行。移行対象なし＝NOTICE は 0 だったはず）'
       ELSE 'REVIEW（0行でない。実測時点からデータが動いた。要確認）' END AS verdict;

-- ============================================================
-- Q4. 00024 が足した列・制約が実在するか
-- ============================================================
-- 期待: 4行すべて verdict = 'OK'。

WITH expected(item, ok) AS (
  VALUES
    ('idempotency_key 列',
     (SELECT count(*) = 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'delivery_log'
         AND column_name = 'idempotency_key')),
    ('attempts 列（NOT NULL / DEFAULT 0）',
     (SELECT count(*) = 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'delivery_log'
         AND column_name = 'attempts' AND is_nullable = 'NO')),
    ('status が NOT NULL',
     (SELECT count(*) = 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'delivery_log'
         AND column_name = 'status' AND is_nullable = 'NO')),
    ('idx_delivery_log_idempotency_key（UNIQUE）',
     (SELECT count(*) = 1 FROM pg_index ix
        JOIN pg_class i ON i.oid = ix.indexrelid
       WHERE i.relname = 'idx_delivery_log_idempotency_key' AND ix.indisunique))
)
SELECT 'Q4' AS q, item, ok, CASE WHEN ok THEN 'OK' ELSE 'NG' END AS verdict
FROM expected;

-- ============================================================
-- 報告のしかた
-- ============================================================
-- Q1〜Q4 の verdict 列だけを貼れば足りる。
-- **鍵・トークンの類はこのクエリでは一切返らない**ので、出力をそのまま貼ってよい。
-- Q3 が REVIEW だった場合は total_rows / still_alert_deferred / status_null の
-- 3つの数字も添えること。
