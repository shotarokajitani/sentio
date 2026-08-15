-- 適用後確認: 新スキーマ12テーブルが正しく作られたか（診断キットQ2相当の差分）
--
-- 実行者: 人間（Supabase Dashboard > SQL Editor）
-- 本クエリは読み取り専用（SELECT のみ）。DDL・DMLを含まず、秘密の値も返さない。
-- 実行タイミング: deploy ワークフローの deploy-migrations ジョブ完了後
--
-- 期待結果: 12行すべてが verdict = 'OK' であること。
--   - rls_enabled       = true   （絶対規則「全テーブルRLS必須」）
--   - policy_count      >= 1     （00019 で操作別4ポリシー、connector_limits は SELECT 1件）
--   - anon_can_select   = true   （00014 で付与。行の絞り込みはRLSが担う）
--   - authenticated_can_select = true
--
-- 1行でも verdict <> 'OK' があれば、その行の詳細を添えて報告すること。

WITH expected(table_name, min_policies) AS (
  VALUES
    ('events', 4), ('entities', 4), ('baselines', 4), ('narratives', 4),
    ('company_summary', 4), ('findings', 4), ('connections', 4),
    ('known_explanations', 4), ('delivery_log', 4), ('budget_usage', 4),
    ('misjudgments', 4),
    -- connector_limits は company_id を持たない共有マスタ。SELECT ポリシー1件のみが正
    ('connector_limits', 1)
),
actual AS (
  SELECT
    c.relname                        AS table_name,
    c.relrowsecurity                 AS rls_enabled,
    (SELECT count(*) FROM pg_policies p
      WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policy_count,
    has_table_privilege('anon',          c.oid, 'SELECT') AS anon_can_select,
    has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated_can_select,
    has_table_privilege('authenticated', c.oid, 'INSERT') AS authenticated_can_insert
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
)
SELECT
  e.table_name,
  (a.table_name IS NOT NULL)   AS created,
  a.rls_enabled,
  a.policy_count,
  e.min_policies               AS policy_count_expected_min,
  a.anon_can_select,
  a.authenticated_can_select,
  a.authenticated_can_insert,
  CASE
    WHEN a.table_name IS NULL              THEN 'NG: テーブルが作成されていない'
    WHEN NOT a.rls_enabled                 THEN 'NG: RLS無効（絶対規則違反）'
    WHEN a.policy_count < e.min_policies   THEN 'NG: ポリシー数が不足'
    WHEN NOT a.anon_can_select             THEN 'NG: anon SELECT が未付与（00014未適用の疑い）'
    WHEN NOT a.authenticated_can_select    THEN 'NG: authenticated SELECT が未付与'
    ELSE 'OK'
  END                          AS verdict
FROM expected e
LEFT JOIN actual a ON a.table_name = e.table_name
ORDER BY verdict DESC, e.table_name;


-- 補助確認①: 旧スキーマ側の権限が広がっていないこと。
-- 00014 を明示リスト化した目的は「旧テーブルに authenticated の書き込みを付けない」こと。
-- 期待結果: authenticated_can_insert が全行 false
--   （true の行があれば、それは旧プロジェクト時代からの既存付与か、意図しない拡大。要報告）
SELECT
  c.relname                                             AS legacy_table,
  c.relrowsecurity                                      AS rls_enabled,
  (SELECT count(*) FROM pg_policies p
    WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policy_count,
  has_table_privilege('anon',          c.oid, 'SELECT') AS anon_can_select,
  has_table_privilege('authenticated', c.oid, 'INSERT') AS authenticated_can_insert,
  has_table_privilege('authenticated', c.oid, 'UPDATE') AS authenticated_can_update,
  has_table_privilege('authenticated', c.oid, 'DELETE') AS authenticated_can_delete
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname NOT IN (
    'events','entities','baselines','narratives','company_summary','findings',
    'connections','connector_limits','known_explanations','delivery_log',
    'budget_usage','misjudgments'
  )
ORDER BY c.relname;


-- 補助確認②: migration履歴が 00001〜00019 で揃い、孤児2件が消えていること。
-- 期待結果: 19行（00001〜00019）。20260414183617 / 20260414183945 は現れない
SELECT version
FROM supabase_migrations.schema_migrations
ORDER BY version;
