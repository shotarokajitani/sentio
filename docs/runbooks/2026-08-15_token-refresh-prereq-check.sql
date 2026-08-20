-- トークンリフレッシュ検証の前提確認（runbook §2〜§4 の統合版）
--
-- 実行者: 人間（Supabase Dashboard > SQL Editor）
-- 実行方法: **このファイル全体を1回コピペして実行する。** 結果は1つのグリッドに出る。
-- 安全性: 読み取り専用。SELECT のみで DDL・DML・SET ROLE を含まない。
--         秘密の値は返さない（service_role_key は存在有無のみ）。
--
-- 前提: 00012 / 00017 / 00018 / 00020 が適用済みであること
--       （00001〜00019 は deploy run 31889710493 で適用確認済み。
--         pg_cron も有効なので cron.job は参照可能）
--
-- 期待結果: 全行 verdict = 'OK'。1行でも NG があれば、その行を添えて報告すること。
--
-- 【runbook §2 からの変更点】
--   旧版は `SET ROLE authenticated` → 失敗するはずの関数呼び出し → `RESET ROLE` の
--   3ステップだった。これは (a) 読み取り専用でない (b) 2文目が例外で終わるため
--   1回コピペにできない (c) RESET ROLE の流し忘れでセッションが権限降格したまま残る、
--   という3つの問題がある。
--   has_function_privilege() でカタログを直接見れば同じ判定が読み取り専用・1文で得られる。
--
-- 【2026-08-18 追記・重要な限界】
--   このカタログ参照は「関数が在る・service_roleが実行できる」までしか見ていない。
--   **存在と実行可能性は、正しく動くことを意味しない。**
--   実際 update_vault_secret は seq1〜4 が全てOKだった状態で
--   `permission denied for table secrets` により動作しなかった（00022で修正）。
--   関数の動作確認は、カタログではなく実際に呼ぶテストで担保すること
--   （tests/integration/vault-token-rotation.test.ts が実DBに対して呼んでいる）。

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
    AND p.proname IN ('store_vault_secret', 'read_vault_secret', 'update_vault_secret',
                      'read_vault_secret_by_name')
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
    count(*)                                                          AS n_jobs,
    min(schedule)                                                     AS schedule,
    bool_and(active)                                                  AS all_active,
    -- 00020 で本文が Vault 参照に置き換わったかを実物で確認する。
    -- GUC 参照が残っていれば 00020 が効いていない
    bool_and(command LIKE '%read_vault_secret_by_name%')              AS uses_vault,
    bool_or(command LIKE '%current_setting(''app.settings%')          AS uses_guc
  FROM cron.job
  WHERE jobname = 'sync-connections'
),
-- 秘密の保管先は Vault（GUC方式は本番で 42501 により経路が塞がっていた。
-- 経緯は 2026-08-15_guc-setup-procedure.md）。
-- name のみを数える。decrypted_secrets には触らないので実値は一切返らない。
secrets AS (
  SELECT
    count(*) FILTER (WHERE name = 'sentio_supabase_url')      AS n_url,
    count(*) FILTER (WHERE name = 'sentio_service_role_key')  AS n_key
  FROM vault.secrets
),
runs AS (
  SELECT
    count(*)                                              AS n_runs,
    count(*) FILTER (WHERE status = 'failed')             AS n_failed,
    max(start_time)                                       AS last_run,
    (array_agg(return_message ORDER BY start_time DESC)
       FILTER (WHERE status = 'failed'))[1]               AS last_error
  -- 2026-08-20 追記: ここで数えられるのは「cronが実行したSQLの成否」まで。
  -- net.http_post は非同期なので、Edge Function が 401/500 を返しても failed にならない。
  -- 関数側の成否は net._http_response / ダッシュボードの Logs で見ること。
  FROM cron.job_run_details
  WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname = 'sync-connections')
)
SELECT * FROM (
  -- §2 Vault関数
  SELECT 1 AS seq, '§2 Vault関数の存在' AS check_name,
         format('%s件: %s', n_fns, coalesce(fn_list, '(なし)')) AS observed,
         '4件 (store/read/update/read_by_name)' AS expected,
         CASE WHEN n_fns = 4 THEN 'OK'
              WHEN n_fns = 3 THEN 'NG: 00020未適用の疑い（read_vault_secret_by_name欠落）'
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
  -- 00020 が効いているかを cron 本文の実物で確認する
  SELECT 6, '§3 cron本文が Vault 参照になっているか',
         format('vault参照=%s / GUC参照=%s',
                coalesce(uses_vault::text, '-'), coalesce(uses_guc::text, '-')),
         'vault参照=true / GUC参照=false',
         CASE WHEN uses_vault AND NOT uses_guc THEN 'OK'
              WHEN n_jobs = 0 THEN 'NG: ジョブ自体が無い'
              ELSE 'NG: 00020未適用 — 本文がGUC参照のまま（設定不能なので必ず失敗する）' END
  FROM job
  UNION ALL
  -- §4 Vaultシークレット（未登録だとcronだけが6時間ごとに失敗し続ける）
  SELECT 7, '§4 Vault sentio_supabase_url',
         format('%s件', n_url), '1件（値は確認しない）',
         CASE WHEN n_url = 1 THEN 'OK'
              WHEN n_url = 0 THEN 'NG: 未登録 — cronが毎回失敗する'
              ELSE 'NG: 同名が複数 — read_vault_secret_by_name が曖昧エラーで落ちる' END
  FROM secrets
  UNION ALL
  SELECT 8, '§4 Vault sentio_service_role_key',
         format('%s件', n_key), '1件（値は確認しない）',
         CASE WHEN n_key = 1 THEN 'OK'
              WHEN n_key = 0 THEN 'NG: 未登録 — cronが毎回失敗する'
              ELSE 'NG: 同名が複数 — read_vault_secret_by_name が曖昧エラーで落ちる' END
  FROM secrets
  UNION ALL
  -- 参考: 初回スケジュール発火前は0件で正常
  SELECT 9, '(参考) cron実行実績',
         format('%s件 / 失敗%s件 / 最終=%s / 直近エラー=%s',
                n_runs, n_failed, coalesce(last_run::text, '-'), coalesce(last_error, '-')),
         '発火後に status=succeeded',
         CASE WHEN n_runs = 0 THEN 'INFO: 未発火（次回はUTC 0/6/12/18時）'
              WHEN n_failed = 0 THEN 'OK'
              ELSE 'NG: cron実行が失敗している' END
  FROM runs
) t
ORDER BY seq;
