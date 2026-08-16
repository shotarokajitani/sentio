-- 旧スキーマ削除（00021）の適用後確認 — 読み取り専用
--
-- 実行者: 人間（Supabase Dashboard > SQL Editor）
-- 実行方法: **このファイル全体を1回コピペして実行する。**
-- 安全性: SELECT のみ。DDL・DML を含まない。秘密の値は返さない。
-- 実行タイミング: deploy ワークフローの deploy-migrations 完了後
--
-- 期待結果: seq 1〜5 がすべて verdict = 'OK'。
--   「旧16テーブルが消えたこと」と「新12テーブルが無傷であること」を対で確認する。
--   片方だけ見ると、消し過ぎ（CASCADEの巻き添え等）を見落とす。

WITH legacy(name) AS (
  VALUES ('companies'),('signals'),('patterns'),('industry_patterns'),
         ('competitors'),('conversations'),('questions'),('integrations'),
         ('external_data'),('subscriptions'),('usage_logs'),('click_tokens'),
         ('cron_job_logs'),('notification_logs'),('api_keys'),('error_logs')
),
newschema(name, min_policies) AS (
  VALUES ('events',4),('entities',4),('baselines',4),('narratives',4),
         ('company_summary',4),('findings',4),('connections',4),
         ('known_explanations',4),('delivery_log',4),('budget_usage',4),
         ('misjudgments',4),('connector_limits',1)
),
actual AS (
  SELECT c.relname, c.relrowsecurity AS rls,
         (SELECT count(*) FROM pg_policies p
           WHERE p.schemaname='public' AND p.tablename=c.relname) AS pol
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r'
),
leftover AS (SELECT a.relname FROM actual a JOIN legacy l ON l.name = a.relname),
missing_new AS (
  SELECT s.name FROM newschema s
  WHERE NOT EXISTS (SELECT 1 FROM actual a WHERE a.relname = s.name)
),
broken_new AS (
  SELECT s.name FROM newschema s
  JOIN actual a ON a.relname = s.name
  WHERE NOT a.rls OR a.pol < s.min_policies
),
unexpected AS (
  SELECT a.relname FROM actual a
  WHERE a.relname NOT IN (SELECT name FROM newschema)
    AND a.relname NOT IN (SELECT name FROM legacy)
)
SELECT * FROM (
  SELECT 1 AS seq, '① 旧16テーブルが消えたか' AS check_name,
         coalesce((SELECT string_agg(relname, ', ') FROM leftover), '(残存なし)') AS observed,
         '残存なし' AS expected,
         CASE WHEN (SELECT count(*) FROM leftover) = 0 THEN 'OK'
              ELSE 'NG: 削除されていない旧テーブルがある' END AS verdict
  UNION ALL
  SELECT 2, '② 新12テーブルが無傷か（存在）',
         coalesce((SELECT string_agg(name, ', ') FROM missing_new), '(欠落なし)'),
         '欠落なし',
         CASE WHEN (SELECT count(*) FROM missing_new) = 0 THEN 'OK'
              ELSE 'NG: 新スキーマが消えている — 即時報告（巻き添え削除の疑い）' END
  UNION ALL
  SELECT 3, '③ 新12テーブルが無傷か（RLS・ポリシー数）',
         coalesce((SELECT string_agg(name, ', ') FROM broken_new), '(異常なし)'),
         '異常なし',
         CASE WHEN (SELECT count(*) FROM broken_new) = 0 THEN 'OK'
              ELSE 'NG: RLS無効またはポリシー数不足のテーブルがある' END
  UNION ALL
  SELECT 4, '④ public に想定外のテーブルが残っていないか',
         coalesce((SELECT string_agg(relname, ', ') FROM unexpected), '(なし)'),
         'なし',
         CASE WHEN (SELECT count(*) FROM unexpected) = 0 THEN 'OK'
              ELSE 'INFO: 新旧いずれのリストにも無いテーブル。出所を確認すること' END
  UNION ALL
  SELECT 5, '⑤ cronジョブ',
         coalesce((SELECT string_agg(format('%s[active=%s]', jobname, active), ', ')
                   FROM cron.job), '(なし)'),
         'sync-connections のみ / active=true',
         CASE WHEN (SELECT count(*) FROM cron.job) = 1
               AND (SELECT count(*) FROM cron.job WHERE jobname='sync-connections' AND active) = 1
              THEN 'OK' ELSE 'NG: 想定外のジョブが残っている、または sync-connections が停止している' END
  UNION ALL
  SELECT 6, '(参考) migration履歴',
         (SELECT format('%s件 / 最新=%s', count(*), max(version))
          FROM supabase_migrations.schema_migrations),
         '21件 / 最新=00021',
         'INFO'
) t
ORDER BY seq;
