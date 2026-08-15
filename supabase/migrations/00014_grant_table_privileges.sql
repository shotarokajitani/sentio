-- 00014: ロール別テーブル権限付与
-- service_role: 全操作（Edge Function / バックエンド用。RLSはバイパスされる）
-- authenticated: 自社データの読み書き（行の絞り込みはRLSが担う）
-- anon: S0データの読み取り（同上）
--
-- 2026-08-15 変更（診断キット分岐C）:
--   旧実装は `GRANT ... ON ALL TABLES IN SCHEMA public` を使っていた。
--   本番には旧プロジェクト由来のテーブルが14件（＋想定外2件）残存しており、
--   これを流すと**旧テーブルにも authenticated の INSERT/UPDATE/DELETE が新規付与される**。
--   旧テーブルのRLSポリシー内容は未検証のため、権限の拡大は許容できない。
--   よって対象を新スキーマ12テーブルの明示リストに限定する。

-- スキーマ使用権限（テーブル権限とは別。これが無いと何も参照できない）
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO service_role;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('events'), ('entities'), ('baselines'), ('narratives'), ('company_summary'),
      ('findings'), ('connections'), ('connector_limits'), ('known_explanations'),
      ('delivery_log'), ('budget_usage'), ('misjudgments')
    ) AS t(tablename)
  LOOP
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', r.tablename
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', r.tablename
    );
    EXECUTE format('GRANT SELECT ON public.%I TO anon', r.tablename);
  END LOOP;
END;
$$;

-- ALTER DEFAULT PRIVILEGES は意図的に置かない。
--
-- 判断根拠:
--   1. 既存テーブルへの波及は無い。ALTER DEFAULT PRIVILEGES は「以後に作られる」
--      オブジェクトにのみ効くため、旧14テーブルの権限が広がることはない。
--      つまり今回の指摘（旧テーブルへの権限拡大）の直接原因ではない。
--   2. それでも外すのは、このファイルが「誰に何を許したか」の唯一の台帳であるべきだから。
--      自前のデフォルト権限を残すと、リストに無いテーブルにも権限が付き、
--      台帳と実態がずれる。
--   3. ただし **これは fail-closed を意味しない。**
--      Supabaseホスト環境はプロジェクト初期化時に anon / authenticated / service_role 向けの
--      デフォルト権限を**プラットフォーム側で**設定しており、自前の
--      ALTER DEFAULT PRIVILEGES を消してもそれは打ち消せない。
--      public に新規作成したテーブルには本番でもビルトインの権限が付く。
--      「明示しないと権限が付かない」状態が成立するのはローカル(supabase start)だけ。
--   4. したがって新テーブルの安全の本線は GRANT 側ではなく、
--      CLAUDE.md 絶対規則「全テーブルRLS必須」である
--      （RLS有効かつポリシー未定義なら非superuserから全拒否＝fail-closed）。
--      新テーブルを追加したら、本ファイルのリストより先に
--      **00013 のRLS検証リストへの追記を確認すること**。
--      00014 への追記漏れは service_role の権限エラーとして顕在化するが、
--      00013 への追記漏れは**エラーにならず静かに全公開になる**。
