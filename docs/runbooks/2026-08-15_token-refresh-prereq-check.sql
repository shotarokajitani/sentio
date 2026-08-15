-- トークンリフレッシュ検証の前提確認（runbook §2〜§4 の統合版）
--
-- 実行者: 人間（Supabase Dashboard > SQL Editor）
-- 実行方法: **このファイル全体を1回コピペして実行する。** 結果は1つのグリッドに出る。
-- 安全性: 読み取り専用。SELECT のみで DDL・DML・SET ROLE を含まない。
--         秘密の値は返さない（service_role_key は存在有無のみ）。
--
-- 前提: 00012 / 00017 / 00018 が適用済みであること
--       （deploy run 31889710493 で適用確認済み。pg_cron も有効なので cron.job は参照可能）
--
-- 期待結果: 全行 verdict = 'OK'。1行でも NG があれば、その行を添えて報告すること。
--
-- 【runbook §2 からの変更点】
--   旧版は `SET ROLE authenticated` → 失敗するはずの関数呼び出し → `RESET ROLE` の
--   3ステップだった。これは (a) 読み取り専用でない (b) 2文目が例外で終わるため
--   1回コピペにできない (c) RESET ROLE の流し忘れでセッションが権限降格したまま残る、
--   という3つの問題がある。
--   has_function_privilege() でカタログを直接見れば同じ判定が読み取り専用・1文で得られる。

WITH vault AS (
  SELECT
    p.proname,
    p.prosecdef,
    has_function_privilege('service_role',  p.oid, 'EXECUTE') AS svc_exec,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
    has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_exec
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('store_vault_secret', 'read_vault_secret', 'update_vault_secret')
),
vault_agg AS (
  SELECT
    count(*)                                          AS n_fns,
    count(*) FILTER (WHERE prosecdef)                 AS n_secdef,
    count(*) FILTER (WHERE svc_exec)                  AS n_svc,
    count(*) FILTER (WHERE auth_exec OR anon_exec)    AS n_leaked,
    string_agg(proname, ', ' ORDER BY proname)        AS fn_list
  FROM vault
),
job AS (
  SELECT
    count(*)              AS n_jobs,
    min(schedule)         AS schedule,
    bool_and(active)      AS all_active
  FROM cron.job
  WHERE jobname = 'sync-connections'
),
guc AS (
  SELECT
    current_setting('app.settings.supabase_url', true)     AS url,
    current_setting('app.settings.service_role_key', true) AS key
),
runs AS (
  SELECT
    count(*)                                              AS n_runs,
    count(*) FILTER (WHERE status = 'failed')             AS n_failed,
    max(start_time)                                       AS last_run,
    (array_agg(return_message ORDER BY start_time DESC)
       FILTER (WHERE status = 'failed'))[1]               AS last_error
  FROM cron.job_run_details
  WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname = 'sync-connections')
)
SELECT * FROM (
  -- §2 Vault関数
  SELECT 1 AS seq, '§2 Vault関数の存在' AS check_name,
         format('%s件: %s', n_fns, coalesce(fn_list, '(なし)')) AS observed,
         '3件 (store/read/update)' AS expected,
         CASE WHEN n_fns = 3 THEN 'OK'
              WHEN n_fns = 2 THEN 'NG: 00017未適用の疑い'
              ELSE 'NG: 00012未適用の疑い' END AS verdict
  FROM vault_agg
  UNION ALL
  SELECT 2, '§2 security definer',
         format('%s/%s件', n_secdef, n_fns), '全件 true',
         CASE WHEN n_fns > 0 AND n_secdef = n_fns THEN 'OK' ELSE 'NG: 権限昇格経路が想定と異なる' END
  FROM vault_agg
  UNION ALL
  SELECT 3, '§2 service_role のEXECUTE',
         format('%s/%s件', n_svc, n_fns), '全件 true',
         CASE WHEN n_fns > 0 AND n_svc = n_fns THEN 'OK' ELSE 'NG: Edge Functionから呼べない' END
  FROM vault_agg
  UNION ALL
  -- ここが 00017 のREVOKEが効いているかの本体
  SELECT 4, '§2 anon/authenticated のEXECUTE剥奪',
         format('漏れ %s件', n_leaked), '0件',
         CASE WHEN n_leaked = 0 THEN 'OK'
              ELSE 'NG: Vault操作が間接的に開いている＝要即時対応' END
  FROM vault_agg
  UNION ALL
  -- §3 pg_cronジョブ
  SELECT 5, '§3 cronジョブ sync-connections',
         format('%s件 / schedule=%s / active=%s',
                n_jobs, coalesce(schedule, '-'), coalesce(all_active::text, '-')),
         '1件 / 0 0,6,12,18 * * * / true',
         CASE WHEN n_jobs = 1 AND schedule = '0 0,6,12,18 * * *' AND all_active THEN 'OK'
              WHEN n_jobs = 0 THEN 'NG: 00018未適用の疑い'
              ELSE 'NG: スケジュールまたはactiveが想定と異なる' END
  FROM job
  UNION ALL
  -- §4 GUC（未設定だとcronだけが6時間ごとに静かに失敗し続ける）
  SELECT 6, '§4 GUC app.settings.supabase_url',
         coalesce(url, '(未設定)'), 'https://<project-ref>.supabase.co',
         CASE WHEN url IS NULL OR url = '' THEN 'NG: 未設定 — cronが毎回失敗する'
              WHEN url LIKE 'https://%.supabase.co' THEN 'OK'
              ELSE 'NG: 形式が想定と異なる' END
  FROM guc
  UNION ALL
  SELECT 7, '§4 GUC app.settings.service_role_key',
         CASE WHEN key IS NULL OR key = '' THEN '(未設定)' ELSE '(設定あり・値は非表示)' END,
         '設定あり',
         CASE WHEN key IS NULL OR key = '' THEN 'NG: 未設定 — cronが毎回失敗する' ELSE 'OK' END
  FROM guc
  UNION ALL
  -- 参考: 初回スケジュール発火前は0件で正常
  SELECT 8, '(参考) cron実行実績',
         format('%s件 / 失敗%s件 / 最終=%s / 直近エラー=%s',
                n_runs, n_failed, coalesce(last_run::text, '-'), coalesce(last_error, '-')),
         '発火後に status=succeeded',
         CASE WHEN n_runs = 0 THEN 'INFO: 未発火（次回はUTC 0/6/12/18時）'
              WHEN n_failed = 0 THEN 'OK'
              ELSE 'NG: cron実行が失敗している' END
  FROM runs
) t
ORDER BY seq;
