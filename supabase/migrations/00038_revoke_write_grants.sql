-- 00038: `authenticated` から TRUNCATE と、残っていた書き込みを外す（発注 ①-1.5）
--
-- ## 1. TRUNCATE（events / entities / connections）
--
-- **TRUNCATE には RLS が一切掛からない。** 行を絞る仕組みは DELETE には効くが、
-- TRUNCATE は表ごと空にする DDL 寄りの操作で、ポリシーの評価を通らない。
-- `authenticated` がこれを持っている限り、**ログインした顧客が全社の events を
-- 1文で消せる。** 00036 は DELETE/INSERT/UPDATE を締めたが TRUNCATE を見ていなかった。
--
-- `REFERENCES`（他人の表に外部キーを張る）と `TRIGGER`（他人の表にトリガを仕掛ける）も
-- 同じ理由で外す。顧客が持つ理由が無い。
--
-- ## 2. connector_limits / known_explanations（00036 の実装漏れ）
--
-- 00036 の本文は「読むだけにする」と書き、`GRANT SELECT` も書いている。
-- しかし `REVOKE ALL ON ... FROM anon;` の相手が **anon だけ**で、
-- `authenticated` が入っていなかった。**GRANT は既存の権限を消さない**ので、
-- 元の DELETE/INSERT/UPDATE/TRUNCATE がそのまま残った。
-- 自表検証（00036 の 4-1）の一覧にもこの2表が無く、migration は緑で通った。
--
-- 実測（2026-09-09・本番の `information_schema.role_table_grants`）:
--
--   connector_limits    DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
--   known_explanations  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
--
-- ## 正本は docs/checklists/table-grants.yml
--
-- **一覧を人が書き写すと必ずずれる**（00036 がそうなった）。表の分類は
-- `docs/checklists/table-grants.yml` に1か所だけ置き、`scripts/check-table-grants.ts`
-- が「宣言 × このファイルの配列 × 実DBの GRANT」を3方向で突き合わせる。
-- ここの配列を触ったら、宣言も触らないと CI が赤くなる。
--
-- ## 冪等性
--
-- REVOKE と GRANT だけ。再実行安全。

-- ---------------------------------------------------------------------------
-- 1. 読むだけの表（authenticated は SELECT のみ）
--    ▼ 正本: docs/checklists/table-grants.yml の read_only
-- ---------------------------------------------------------------------------
REVOKE ALL ON baselines, budget_usage, company_summary, connection_events,
              connector_limits, delivery_log, findings, known_explanations,
              misjudgments, narratives
  FROM anon, authenticated;

GRANT SELECT ON baselines, budget_usage, company_summary, connection_events,
                connector_limits, delivery_log, findings, known_explanations,
                misjudgments, narratives
  TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. 書き込みが残る表。**TRUNCATE / REFERENCES / TRIGGER は渡さない**
--    ▼ 正本: docs/checklists/table-grants.yml の writable
-- ---------------------------------------------------------------------------
REVOKE ALL ON connections, entities, events FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON connections, entities, events TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. 自表検証。**期待と違えば migration を失敗させる**
--
--    一覧はこのファイルの中で1度だけ書き、3つのループが同じ配列を使う。
--    00036 は「締める表の一覧」と「検証する表の一覧」が別々に書かれていて、
--    後者に2表が入っていなかったために漏れを見逃した
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  read_only  TEXT[] := ARRAY['baselines', 'budget_usage', 'company_summary',
                             'connection_events', 'connector_limits', 'delivery_log',
                             'findings', 'known_explanations', 'misjudgments', 'narratives'];
  writable   TEXT[] := ARRAY['connections', 'entities', 'events'];
  never      TEXT[] := ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER'];
  t TEXT;
  p TEXT;
BEGIN
  -- 3-1. 読むだけの表に、authenticated の書き込みが残っていないこと
  FOREACH t IN ARRAY read_only LOOP
    FOREACH p IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
      IF has_table_privilege('authenticated', t, p) THEN
        RAISE EXCEPTION '00038: authenticated が % に % できる（読むだけの表である）', t, p;
      END IF;
    END LOOP;
    IF NOT has_table_privilege('authenticated', t, 'SELECT') THEN
      RAISE EXCEPTION '00038: authenticated が % を読めない（読むのは残す）', t;
    END IF;
  END LOOP;

  -- 3-2. 書き込みを残す表は、残っていること（**止めるつもりが無いものを止めない**）
  FOREACH t IN ARRAY writable LOOP
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('authenticated', t, p) THEN
        RAISE EXCEPTION '00038: authenticated が % に % できない（残す約束である）', t, p;
      END IF;
    END LOOP;
  END LOOP;

  -- 3-3. **全表で** TRUNCATE / REFERENCES / TRIGGER を持っていないこと
  FOREACH t IN ARRAY read_only || writable LOOP
    FOREACH p IN ARRAY never LOOP
      IF has_table_privilege('authenticated', t, p) THEN
        RAISE EXCEPTION '00038: authenticated が % に % を持っている', t, p;
      END IF;
    END LOOP;
  END LOOP;

  -- 3-4. anon は1つも持っていないこと
  FOREACH t IN ARRAY read_only || writable LOOP
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] || never LOOP
      IF has_table_privilege('anon', t, p) THEN
        RAISE EXCEPTION '00038: anon が % に % を持っている', t, p;
      END IF;
    END LOOP;
  END LOOP;
END $$;
