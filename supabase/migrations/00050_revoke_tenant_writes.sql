-- 00050: `authenticated` から events / entities / connections の書き込みを外す（2026-09-13 の点検・PR-2b）
--
-- ## 何が起きていたか
--
-- 00038 は、Next の Route Handler が利用者のクライアントでこの3表を書いていたので、
-- `authenticated` に INSERT / UPDATE / DELETE を残していた。
-- **RLS は「どの行か」を絞るだけで、自社の行なら通る。** ログインした利用者は API を通さず
-- PostgREST を直に叩いて、自社の events を書き換え、connections.status を変え、
-- entities を消せた（entities を消せば competitors/suggest の冪等ガードも外れた）。
--
-- PR-2a（#126）で3本の route の書き込みを service_role に寄せ、本番で確認した
-- （2026-09-13 16:10:54Z に Vercel READY、CSV 取り込み1回が service_role で成功）。
-- **書き込み経路が先に移っているので、ここで権限を外しても取り込みと解除は止まらない。**
--
-- ## 1. 3表を「読むだけ」に移す
--
-- SELECT は残す。/connect・/report は利用者のクライアントで読んでいる。
--
-- ## 2. 何も渡さない表を宣言に載せる
--
-- RLS 有効・ポリシー無しで、`authenticated` / `anon` に1つも権限を持たせない表。
-- 自表検証の配列に載せ、`docs/checklists/table-grants.yml` の `no_access` と
-- `scripts/check-table-grants.ts` が突き合わせる。
--
-- ## 3. retention_purge_runs に `api_rate_limits` の種別を足す
--
-- retention-purge が `api_rate_limits` の古い窓（2日より前）を数えて・消した記録を残す。
-- 会社に紐づかない削除なので、`run` と同じく company_id は NULL になる。
--
-- ## 正本は docs/checklists/table-grants.yml
--
-- 自表検証の配列（read_only / writable / no_access / never）は宣言と一致させる。
-- 00038 の配列はこのファイルに引き継いだ（検査器の突合先もこのファイルに移した）。
--
-- ## 冪等性
--
-- REVOKE / GRANT / DROP CONSTRAINT IF EXISTS → ADD CONSTRAINT のみ。再実行安全。

-- ---------------------------------------------------------------------------
-- 1. 3表の書き込みを外す（SELECT は残す）
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE ON connections, entities, events FROM authenticated;

-- ---------------------------------------------------------------------------
-- 2. 何も渡さない表。**念のため明示的に外す**（既に何も持っていないことは照会済み）
-- ---------------------------------------------------------------------------
REVOKE ALL ON api_rate_limits, billing_webhook_events, billing_webhook_unresolved,
              dispatch_runs, retention_purge_runs
  FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. retention_purge_runs の種別
-- ---------------------------------------------------------------------------
ALTER TABLE retention_purge_runs DROP CONSTRAINT IF EXISTS retention_purge_runs_kind_check;
ALTER TABLE retention_purge_runs ADD CONSTRAINT retention_purge_runs_kind_check
  CHECK (kind IN ('run', 'retention_months', 'revoked_grace', 'api_rate_limits'));

-- **会社ごとの行に company_id が無い、を許さない。** NULL でよいのは会社に紐づかない記録だけ
ALTER TABLE retention_purge_runs DROP CONSTRAINT IF EXISTS retention_purge_runs_company_check;
ALTER TABLE retention_purge_runs ADD CONSTRAINT retention_purge_runs_company_check
  CHECK (
    (kind IN ('run', 'api_rate_limits') AND company_id IS NULL)
    OR (kind NOT IN ('run', 'api_rate_limits') AND company_id IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- 4. 自表検証。**期待と違えば migration を失敗させる**
--
--    一覧はこのファイルの中で1度だけ書き、ループが同じ配列を使う（00038 と同じ作法）
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  read_only  TEXT[] := ARRAY['baselines', 'budget_usage', 'company_summary',
                             'connection_events', 'connections', 'connector_limits',
                             'delivery_log', 'entities', 'events', 'findings',
                             'known_explanations', 'misjudgments', 'narratives'];
  writable   TEXT[] := ARRAY[]::TEXT[];
  no_access  TEXT[] := ARRAY['api_rate_limits', 'billing_webhook_events',
                             'billing_webhook_unresolved', 'dispatch_runs',
                             'retention_purge_runs'];
  never      TEXT[] := ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER'];
  t TEXT;
  p TEXT;
BEGIN
  -- 4-1. 読むだけの表に、authenticated の書き込みが残っていないこと
  FOREACH t IN ARRAY read_only LOOP
    FOREACH p IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
      IF has_table_privilege('authenticated', t, p) THEN
        RAISE EXCEPTION '00050: authenticated が % に % できる（読むだけの表である）', t, p;
      END IF;
    END LOOP;
    IF NOT has_table_privilege('authenticated', t, 'SELECT') THEN
      RAISE EXCEPTION '00050: authenticated が % を読めない（読むのは残す）', t;
    END IF;
  END LOOP;

  -- 4-2. 書き込みを残す表は、残っていること（現時点で0表）
  FOREACH t IN ARRAY writable LOOP
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('authenticated', t, p) THEN
        RAISE EXCEPTION '00050: authenticated が % に % できない（残す約束である）', t, p;
      END IF;
    END LOOP;
  END LOOP;

  -- 4-3. 何も渡さない表は、authenticated も anon も1つも持っていないこと
  FOREACH t IN ARRAY no_access LOOP
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] || never LOOP
      IF has_table_privilege('authenticated', t, p) OR has_table_privilege('anon', t, p) THEN
        RAISE EXCEPTION '00050: authenticated か anon が % に % を持っている（何も渡さない表）', t, p;
      END IF;
    END LOOP;
  END LOOP;

  -- 4-4. **全表で** TRUNCATE / REFERENCES / TRIGGER を持っていないこと
  FOREACH t IN ARRAY read_only || writable LOOP
    FOREACH p IN ARRAY never LOOP
      IF has_table_privilege('authenticated', t, p) THEN
        RAISE EXCEPTION '00050: authenticated が % に % を持っている', t, p;
      END IF;
    END LOOP;
  END LOOP;

  -- 4-5. anon は1つも持っていないこと
  FOREACH t IN ARRAY read_only || writable LOOP
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] || never LOOP
      IF has_table_privilege('anon', t, p) THEN
        RAISE EXCEPTION '00050: anon が % に % を持っている', t, p;
      END IF;
    END LOOP;
  END LOOP;

  -- 4-6. 会社に紐づかない削除の記録が入ること（company_id NULL・kind api_rate_limits）
  INSERT INTO retention_purge_runs (company_id, kind, counted, deleted, decision, dry_run)
    VALUES (NULL, 'api_rate_limits', 0, 0, 'dry_run', true);
  DELETE FROM retention_purge_runs WHERE kind = 'api_rate_limits' AND counted = 0 AND dry_run
    AND created_at >= now() - interval '1 minute';
END $$;

-- 陰性コントロール（直後に revert する）: 自表検証の後で書き込み権限を戻す
GRANT INSERT, UPDATE, DELETE ON connections, entities, events TO authenticated;
