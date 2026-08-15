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
--   2. それでも外すのは、00013 を明示リストに変えたことで
--      「RLS未設定の新テーブル」を機械的に検出する網が無くなったため。
--      デフォルト権限を残すと、RLS未設定のテーブルを作った瞬間に
--      anon の SELECT が自動で付き、"静かな全公開" が成立してしまう。
--      権限は自動で広がるより、明示しないと付かない方（fail-closed）に倒す。
--   3. 代償として、新テーブル追加時は本ファイルのリストへの追記が必須になる。
--      追記漏れは service_role からの権限エラーとして即座に顕在化する（fail-closed）。
