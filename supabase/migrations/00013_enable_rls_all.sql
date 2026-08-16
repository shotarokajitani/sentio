-- 00013: RLS有効化アサーション
-- 新スキーマ12テーブルでRLSが有効であることを検証する
--
-- 2026-08-15 変更（診断キット分岐C）:
--   旧実装は pg_tables を全走査し、RLS未有効のテーブルが1つでもあれば中断していた。
--   本番には4月構築の旧プロジェクト由来テーブルが14件（＋想定外2件）残存しており、
--   全走査は「Sentioが管理していないテーブルの状態」に依存して失敗しうる。
--   本マイグレーションの目的は「Sentioが作った表にRLSが掛かっているか」の検証なので、
--   対象を明示リストに限定する。
--
--   なお本番の旧テーブルは実測で全件 rls_enabled = true であり（Q2）、
--   当時も全走査で素通りしていた。それでも明示リストにしたのは、
--   旧テーブルの状態変化がSentioのデプロイを壊す結合を断つため。
--
-- 2026-08-17 追記: 旧スキーマ16テーブルは 00021 で削除済み。
--   したがって「旧テーブルを避ける」という当初の動機は解消している。
--   それでも明示リストは維持する。理由は動機が変わっただけで残っているため:
--   全走査に戻すと、Sentio が管理していない表（将来 Dashboard 等で作られたもの）が
--   1つ現れただけでデプロイが止まる。検証対象は「Sentioが作った表」に限定するのが正しい。
--   新テーブルを追加したら、このリストへの追記が必須（追記漏れは静かに全公開になる）。
--
-- 注意: 明示リスト化により「新しく作った表がこの検証から漏れる」経路ができる。
--       新テーブルを追加したら、このリストと 00014 のGRANT対象に必ず追記すること
--       （.claude/skills/migration の手順に従う）。

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
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = r.tablename AND c.relkind = 'r'
    ) THEN
      RAISE EXCEPTION 'expected table missing: %', r.tablename;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = r.tablename AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'RLS not enabled on table: %', r.tablename;
    END IF;
  END LOOP;
END;
$$;
