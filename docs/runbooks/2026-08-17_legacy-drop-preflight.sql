-- 旧スキーマ削除（00021）の事前調査 — 読み取り専用
--
-- 実行者: 人間（Supabase Dashboard > SQL Editor）
-- 実行方法: **このファイル全体を1回コピペして実行する。** 結果は1つのグリッドに出る。
-- 安全性: SELECT のみ。DDL・DML を含まない。秘密の値は返さない。
-- 実行タイミング: 00021 を含むPRの「push可」判断の前
--
-- 目的:
--   00021 は CASCADE を使わない。リスト外に依存オブジェクトがあると
--   `cannot drop table ... because other objects depend on it` で**失敗する**
--   （＝deploy が止まる。部分適用はしない）。
--   その失敗を本番デプロイで初めて知るのではなく、ここで先に洗い出す。
--
-- 期待結果: 全行 verdict = 'OK'。
--   seq 4 が NG（sync-connections 以外の cron ジョブあり）だった場合は、
--   その jobname を報告すること — 00021 に cron.unschedule を追記する。

WITH legacy(name) AS (
  VALUES ('companies'),('signals'),('patterns'),('industry_patterns'),
         ('competitors'),('conversations'),('questions'),('integrations'),
         ('external_data'),('subscriptions'),('usage_logs'),('click_tokens'),
         ('cron_job_logs'),('notification_logs'),('api_keys'),('error_logs')
),
-- 実在する旧テーブルの oid
legacy_rel AS (
  SELECT c.oid, c.relname
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN legacy l ON l.name = c.relname
  WHERE n.nspname = 'public' AND c.relkind = 'r'
),
-- ① リスト外のテーブルから旧テーブルへ向いているFK（これがあるとDROPが失敗する）
inbound_fk AS (
  SELECT
    con.conname,
    src.relname  AS from_table,
    tgt.relname  AS to_legacy_table
  FROM pg_constraint con
  JOIN pg_class src ON src.oid = con.conrelid
  JOIN pg_class tgt ON tgt.oid = con.confrelid
  JOIN pg_namespace sn ON sn.oid = src.relnamespace
  WHERE con.contype = 'f'
    AND tgt.oid IN (SELECT oid FROM legacy_rel)
    AND src.oid NOT IN (SELECT oid FROM legacy_rel)   -- 集合内のFKは1文DROPで解決するので除外
),
-- ② 旧テーブルに依存するビュー / マテビュー / 関数など（rewrite 依存）
dependents AS (
  SELECT DISTINCT
    dep_obj.relname AS dependent_object,
    dep_obj.relkind AS kind,
    lr.relname      AS depends_on
  FROM pg_depend d
  JOIN pg_rewrite r  ON r.oid = d.objid
  JOIN pg_class dep_obj ON dep_obj.oid = r.ev_class
  JOIN legacy_rel lr ON lr.oid = d.refobjid
  WHERE d.classid = 'pg_rewrite'::regclass
    AND dep_obj.oid NOT IN (SELECT oid FROM legacy_rel)
),
-- ③ 旧テーブルに付いているトリガー（テーブルと同時に消えるので情報用）
trig AS (
  SELECT t.tgname, lr.relname AS on_table
  FROM pg_trigger t
  JOIN legacy_rel lr ON lr.oid = t.tgrelid
  WHERE NOT t.tgisinternal
),
-- ④ cron ジョブ全件（sync-connections 以外があれば unschedule 対象）
cron_all AS (
  SELECT jobid, jobname, schedule, active, command
  FROM cron.job
),
-- ⑤ 新スキーマ12テーブルが無傷であることの確認用
newschema(name) AS (
  VALUES ('events'),('entities'),('baselines'),('narratives'),('company_summary'),
         ('findings'),('connections'),('connector_limits'),('known_explanations'),
         ('delivery_log'),('budget_usage'),('misjudgments')
)
SELECT * FROM (
  SELECT 1 AS seq, '① 旧テーブルが実在する件数' AS check_name,
         format('%s件 / 16件中', (SELECT count(*) FROM legacy_rel)) AS observed,
         '16件（未削除の状態）' AS expected,
         CASE WHEN (SELECT count(*) FROM legacy_rel) = 16 THEN 'OK'
              WHEN (SELECT count(*) FROM legacy_rel) = 0  THEN 'INFO: 既に削除済み（00021適用後）'
              ELSE 'INFO: 一部のみ存在 — 対象リストと実態を突き合わせること' END AS verdict
  UNION ALL
  -- ここが本命。1件でもあると 00021 は失敗する
  SELECT 2, '② リスト外→旧テーブルへのFK（DROPを失敗させる）',
         coalesce((SELECT string_agg(format('%s(%s→%s)', conname, from_table, to_legacy_table), ', ')
                   FROM inbound_fk), '(なし)'),
         'なし',
         CASE WHEN (SELECT count(*) FROM inbound_fk) = 0 THEN 'OK'
              ELSE 'NG: このFKを先に落とすか、対象リストに当該テーブルを追加する必要がある' END
  UNION ALL
  SELECT 3, '③ 旧テーブルに依存するビュー/関数',
         coalesce((SELECT string_agg(format('%s(%s)→%s', dependent_object, kind, depends_on), ', ')
                   FROM dependents), '(なし)'),
         'なし',
         CASE WHEN (SELECT count(*) FROM dependents) = 0 THEN 'OK'
              ELSE 'NG: 依存オブジェクトを先に削除するか、PRに含める必要がある' END
  UNION ALL
  SELECT 4, '④ cronジョブ（sync-connections以外の有無）',
         coalesce((SELECT string_agg(format('%s[active=%s]', jobname, active), ', ')
                   FROM cron_all), '(なし)'),
         'sync-connections のみ',
         CASE WHEN (SELECT count(*) FROM cron_all WHERE jobname <> 'sync-connections') = 0 THEN 'OK'
              ELSE 'NG: 旧cronジョブあり — jobname を報告し 00021 に cron.unschedule を追記する' END
  UNION ALL
  SELECT 5, '⑤ 旧テーブルのトリガー（情報用・テーブルと同時に消える）',
         coalesce((SELECT string_agg(format('%s on %s', tgname, on_table), ', ') FROM trig), '(なし)'),
         '—',
         'INFO'
  UNION ALL
  SELECT 6, '⑥ 新スキーマ12テーブルの現存（削除前の基準値）',
         format('%s件 / 12件', (SELECT count(*) FROM pg_class c
                                JOIN pg_namespace n ON n.oid = c.relnamespace
                                JOIN newschema s ON s.name = c.relname
                                WHERE n.nspname='public' AND c.relkind='r')),
         '12件',
         CASE WHEN (SELECT count(*) FROM pg_class c
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    JOIN newschema s ON s.name = c.relname
                    WHERE n.nspname='public' AND c.relkind='r') = 12
              THEN 'OK' ELSE 'NG: 削除前から新スキーマが欠けている — 中断して報告' END
) t
ORDER BY seq;
