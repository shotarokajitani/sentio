-- 00019: RLSポリシーに明示的な WITH CHECK を与える
--
-- 背景: 00001〜00011 の全ポリシーは `FOR ALL USING (...)` のみで、WITH CHECK を
-- 省略していた。PostgreSQL は WITH CHECK 省略時に USING 式をそのまま書き込み側に
-- 流用するため、`events` / `known_explanations` の
--   USING (company_id = auth.uid() OR company_id IS NULL)
-- が INSERT にも適用され、**任意の認証ユーザーが company_id = NULL で書き込める**
-- 状態になっていた（RLS監査指摘）。
--
-- 方針:
--   - NULLスコープ行（S0共有データ）の「読み取り」は設計意図どおり維持する
--   - NULLスコープ行への「書き込み」は塞ぐ。service_role は RLS をバイパスするため、
--     結果として NULLスコープ行の書き込みは service_role 限定になる
--   - FOR ALL を操作別4ポリシーへ分割し、INSERT/UPDATE に WITH CHECK を明示する
--
-- 冪等性: DROP POLICY IF EXISTS → CREATE POLICY。再実行安全。
-- テーブルは明示リストで指定する（pg_tables の全走査は、旧スキーマ残存時に
-- 00013 が発火したのと同じ事故を招くため使わない）。

DO $$
DECLARE
  r RECORD;
  select_expr TEXT;
BEGIN
  FOR r IN
    -- allow_null_read: S0共有行（company_id IS NULL）を認証前ロールにも読ませるか
    SELECT * FROM (VALUES
      ('events',             true),
      ('known_explanations', true),
      ('entities',           false),
      ('baselines',          false),
      ('narratives',         false),
      ('company_summary',    false),
      ('findings',           false),
      ('connections',        false),
      ('delivery_log',       false),
      ('budget_usage',       false),
      ('misjudgments',       false)
    ) AS t(table_name, allow_null_read)
  LOOP
    -- 対象テーブルが未作成の環境では何もしない（部分適用環境での再実行安全性）
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = r.table_name AND c.relkind = 'r'
    ) THEN
      CONTINUE;
    END IF;

    select_expr := CASE
      WHEN r.allow_null_read THEN 'company_id = auth.uid() OR company_id IS NULL'
      ELSE 'company_id = auth.uid()'
    END;

    -- 旧: FOR ALL の単一ポリシー
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'users_own_' || r.table_name, r.table_name);

    -- 新: 操作別。再実行時は自分自身も作り直す
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.table_name || '_select', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.table_name || '_insert', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.table_name || '_update', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.table_name || '_delete', r.table_name);

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT USING (%s)',
      r.table_name || '_select', r.table_name, select_expr
    );

    -- 書き込みは自社スコープのみ。NULLスコープは通さない
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (company_id = auth.uid())',
      r.table_name || '_insert', r.table_name
    );

    -- USING で対象行を、WITH CHECK で更新後の行を縛る。
    -- WITH CHECK が無いと、自社行の company_id を他社IDへ書き換えて持ち出せる
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE USING (company_id = auth.uid()) WITH CHECK (company_id = auth.uid())',
      r.table_name || '_update', r.table_name
    );

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE USING (company_id = auth.uid())',
      r.table_name || '_delete', r.table_name
    );
  END LOOP;
END;
$$;

-- connector_limits は company_id を持たないマスタデータ。
-- 00007 で RLS有効 + SELECT のみのポリシーが定義済みで、書き込みポリシーが
-- 存在しない＝非 service_role からの書き込みは既に全拒否。意図的に変更しない。
