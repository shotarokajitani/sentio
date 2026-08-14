# 本番マイグレーション実態 診断キット

作成日: 2026-08-12
目的: `deploy-migrations` ジョブ失敗の根本原因である「本番 migration 履歴と
ローカル `supabase/migrations/` の乖離」を、本番DBを壊さずに確定させる。
実行者: **人間**（Supabase Dashboard > SQL Editor）
凍結事項: 本診断が完了し人間の合図があるまで、`supabase migration repair` /
`DELETE FROM supabase_migrations.schema_migrations` / `supabase db push` は**実行しない**。

> 本番DBへのCLI直接操作はCLAUDE.md絶対規則により禁止。
> 本書のSQLは**すべてDashboard SQL Editorから実行**すること。
> 本書のSQLは全て読み取り専用（SELECT）で、DDL・DMLを含まない。

---

## 背景（実測済みの事実）

| 事実                                                           | 証跡                                                                                                                                          |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy` ワークフローは過去2回しか実行されず、**両方 failure** | `gh run list --workflow=deploy.yml` → 31559757735 / 31576330545 とも failure                                                                  |
| 1回目は `--project-ref` 廃止で失敗                             | `Unrecognized flag: --project-ref in command supabase db push`                                                                                |
| 2回目は `link` 成功後 `db push --linked` が履歴不一致で失敗    | `Remote migration versions not found in local migrations directory.`                                                                          |
| 本番履歴に残る孤児バージョン                                   | `20260414183617` / `20260414183945`                                                                                                           |
| 孤児の出所は**アーカイブ済み旧プロジェクト**                   | `git ls-tree origin/archive/legacy` → `supabase/migrations/20260414_add_industry_to_companies.sql` / `20260414_cron_logs_signals_indexes.sql` |
| ⇒ CI経由で `00001`〜`00018` は**1件も適用されていない**        | deploy-migrations ジョブが一度も成功していないため                                                                                            |

**未確定なのは「本番の実スキーマがどうなっているか」だけ。** CI以外の経路（Dashboard
SQL Editor での手動適用など）で新スキーマが入っている可能性は履歴からは判別できない。
Dashboard SQL Editor で適用したDDLは `supabase_migrations.schema_migrations` に
**記録されない**ため、「履歴に無い＝スキーマにも無い」とは限らない。これを確定させるのが本書。

---

## 診断クエリ（Q1〜Q8 を順に実行し、出力をそのまま保存する）

### Q1. migration 履歴の全行

```sql
SELECT version
FROM supabase_migrations.schema_migrations
ORDER BY version;
```

**読み方:**

- `20260414183617` / `20260414183945` の2行**のみ** → 想定通り（新スキーマは履歴上未適用）
- `00001`〜 が並んでいる → CI以外の経路でCLI適用された履歴がある。本書の前提が崩れるので中断して報告
- 孤児が3件以上ある → 旧プロジェクト由来が他にもある。Q2以降と併せて全件を洗い出す

---

### Q2. public スキーマの全テーブルとRLS状態（**最重要**）

```sql
SELECT
  c.relname                                   AS table_name,
  c.relrowsecurity                            AS rls_enabled,
  c.relforcerowsecurity                       AS rls_forced,
  (SELECT count(*) FROM pg_policies p
    WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policy_count,
  has_table_privilege('anon',          c.oid, 'SELECT') AS anon_can_select,
  has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated_can_select
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
ORDER BY c.relname;
```

**読み方:** この出力が全分岐の起点になる。次のQ3で機械的に仕分けする。

> ⚠️ `rls_enabled = false` かつ `anon_can_select = true` の行があれば、
> それは**現時点で匿名ロールから全行読める本番テーブル**。RLS監査の即時対象。

---

### Q3. 新スキーマ / 旧スキーマ / 想定外 の仕分け

```sql
WITH expected(table_name) AS (VALUES
  ('events'), ('entities'), ('baselines'), ('narratives'), ('company_summary'),
  ('findings'), ('connections'), ('connector_limits'), ('known_explanations'),
  ('delivery_log'), ('budget_usage'), ('misjudgments')
),
legacy(table_name) AS (VALUES
  ('companies'), ('signals'), ('patterns'), ('industry_patterns'), ('competitors'),
  ('conversations'), ('questions'), ('integrations'), ('external_data'),
  ('financials'), ('subscriptions'), ('usage_logs'), ('click_tokens'),
  ('cron_job_logs'), ('notification_logs')
),
actual AS (
  SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
)
SELECT
  COALESCE(a.table_name, e.table_name)          AS table_name,
  CASE
    WHEN e.table_name IS NOT NULL AND a.table_name IS NULL THEN '新スキーマ: 未作成'
    WHEN e.table_name IS NOT NULL                          THEN '新スキーマ: 存在'
    WHEN l.table_name IS NOT NULL                          THEN '旧スキーマ: 残存'
    ELSE '想定外'
  END                                            AS classification,
  a.rls_enabled
FROM actual a
FULL OUTER JOIN expected e ON e.table_name = a.table_name
LEFT JOIN legacy   l ON l.table_name = a.table_name
ORDER BY classification, table_name;
```

**読み方:**

| 出力パターン                  | 意味                                                          |
| ----------------------------- | ------------------------------------------------------------- |
| 「新スキーマ: 未作成」が12件  | 本番は**まっさら**（旧スキーマのみ）。最も単純な分岐          |
| 「新スキーマ: 存在」が12件    | CI外で手動適用済み。**00015の非冪等問題が発火する**（Q6必須） |
| 混在                          | 手動適用が途中まで。最も慎重な対応が要る                      |
| 「旧スキーマ: 残存」が1件以上 | **00013が必ず失敗する**（後述の分岐C）                        |

---

### Q4. Vault ヘルパー関数（00012 / 00017 の判別）

```sql
SELECT
  p.proname                                                  AS function_name,
  pg_get_function_identity_arguments(p.oid)                  AS arguments,
  p.prosecdef                                                AS is_security_definer,
  has_function_privilege('service_role',  p.oid, 'EXECUTE')  AS service_role_exec,
  has_function_privilege('authenticated', p.oid, 'EXECUTE')  AS authenticated_exec,
  has_function_privilege('anon',          p.oid, 'EXECUTE')  AS anon_exec
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('store_vault_secret', 'read_vault_secret', 'update_vault_secret')
ORDER BY p.proname;
```

**読み方:**

| 結果                                                                 | 判定                                                                        |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 0行                                                                  | 00012 も 00017 も未適用                                                     |
| `store_vault_secret` / `read_vault_secret` の2行のみ                 | 00012 のみ適用・**00017 未適用**                                            |
| 3行あり、かつ全行 `authenticated_exec = false` / `anon_exec = false` | 00017 適用済み（REVOKEも効いている）                                        |
| 3行あるが `authenticated_exec = true`                                | 関数だけ作られREVOKEが未適用。**Vault操作が間接的に開いている＝要即時対応** |

---

### Q5. 拡張と pg_cron ジョブ（00018 の判別）

```sql
SELECT extname, extversion
FROM pg_extension
WHERE extname IN ('pg_cron', 'pg_net', 'supabase_vault')
ORDER BY extname;
```

**`pg_cron` が上の結果に無い場合、次のクエリは実行しない**（`relation "cron.job" does not exist` になる）。
`pg_cron` があった場合のみ実行:

```sql
SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname = 'sync-connections';
```

**読み方:**

- `pg_cron` / `pg_net` が無い → **00018 は適用できない**。`cron.schedule()` が
  `schema "cron" does not exist` で失敗し、db push が 00018 で停止する。
  マイグレーション側に `CREATE EXTENSION` が無いため、**拡張の有効化が先行して必要**
  （Dashboard > Database > Extensions、または `CREATE EXTENSION IF NOT EXISTS pg_cron; CREATE EXTENSION IF NOT EXISTS pg_net;`）
- ジョブが1件あり `active = true` → 00018 適用済み（`cron.schedule` は同名ジョブを
  上書きするため再適用は安全）

---

### Q6. `delivery_log` の列構成（**00015 の非冪等箇所の判定**）

```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'delivery_log'
ORDER BY ordinal_position;
```

**読み方（00015 は再実行安全でない唯一のマイグレーション）:**

`00015_alter_delivery_log_union_schema.sql` の14行目は

```sql
UPDATE delivery_log SET delivery_type = frame WHERE delivery_type IS NULL AND frame IS NOT NULL;
```

で、同ファイルの23行目が `ALTER TABLE delivery_log DROP COLUMN IF EXISTS frame;` を実行する。
つまり**一度適用された後にもう一度流すと、14行目が `column "frame" does not exist` で失敗する**。

| `frame` 列                | `channel`/`delivery_type`/`content`/`status`/`created_at` | 判定             | 00015 再実行                  |
| ------------------------- | --------------------------------------------------------- | ---------------- | ----------------------------- |
| 有り                      | 無し                                                      | 00015 未適用     | **安全**                      |
| 無し                      | 有り                                                      | 00015 適用済み   | **失敗する — 要対処（下記）** |
| 有り                      | 有り                                                      | 途中適用         | **失敗する — 要対処（下記）** |
| `delivery_log` 自体が無い | —                                                         | 00009 から未適用 | **安全**                      |

**「失敗する」だった場合の対処案**（人間の承認後に実施。まだ実行しない）:
00015 の14行目を列存在ガードで包み、再実行可能にする。

```sql
-- 00015 の14行目を以下に置き換える案
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'delivery_log' AND column_name = 'frame'
  ) THEN
    UPDATE delivery_log SET delivery_type = frame
    WHERE delivery_type IS NULL AND frame IS NOT NULL;
  END IF;
END $$;
```

この修正は「`frame` が既に無い＝移行済み」という事実に対して正しく no-op になるため、
未適用環境（ローカル・プレビュー）での挙動は変わらない。

---

### Q7. `connections` のインデックス（00016 の判別）

```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'connections'
ORDER BY indexname;
```

**読み方:**

- `idx_connections_company_provider` が UNIQUE で存在 → 00016 適用済み
- 存在しない → 未適用。ただし `CREATE UNIQUE INDEX IF NOT EXISTS` は
  **`(company_id, provider)` に重複行があると失敗する**。適用前に重複を確認:

```sql
SELECT company_id, provider, count(*)
FROM connections
GROUP BY company_id, provider
HAVING count(*) > 1;
-- 期待結果: 0行。1行でも返ったら 00016 は失敗する
```

---

### Q8. ロール権限（00014 の判別）

```sql
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name = 'events'
  AND grantee IN ('anon', 'authenticated', 'service_role')
ORDER BY grantee, privilege_type;
```

**読み方:** `anon` に SELECT、`authenticated` / `service_role` に
SELECT/INSERT/UPDATE/DELETE が揃っていれば 00014 適用済み。

> ⚠️ **00014 は `GRANT ... ON ALL TABLES IN SCHEMA public` を使う。**
> 旧スキーマのテーブルが残っている状態で 00014 を流すと、
> `companies` / `signals` などの**旧テーブルにも `anon` の SELECT 権限が付く**。
> 旧テーブルのRLSが無効なら、その瞬間に匿名で全行読めるようになる。
> 分岐C（旧スキーマ残存）では、この点だけで push を止める理由になる。

---

## 結果の解釈表 — どの結果ならどの修復経路か

Q1〜Q8 の結果を下表に当てはめ、該当する分岐を1つ選ぶ。

### 分岐A: 本番はまっさら（Q3で「新スキーマ: 未作成」が12件、かつ旧スキーマ残存が0件）

**最も単純。** 履歴の孤児2件を除去すれば `00001`〜`00018` が素直に通る。

- 修復経路: **選択肢1（CI に repair step を追加）**
  `deploy-migrations` の `db push` 前に
  `supabase migration repair --status reverted 20260414183617 20260414183945` を挿入。
  対象を2バージョンにハードコードするため、将来の別ドリフトは従来通り失敗として顕在化する。
- 事前条件: Q5 で `pg_cron` / `pg_net` が有効であること（無ければ先に拡張を有効化）
- 00015 は未適用なので非冪等問題は起きない
- 残るリスク: なし（全マイグレーションがガード付きで初回適用）

### 分岐B: 新スキーマが手動適用済みで併存（Q3で「新スキーマ: 存在」が12件）

履歴には残っていないがスキーマは出来ている状態。push は全件を「未適用」とみなして流す。

- 00001〜00014・00016〜00018 は `IF NOT EXISTS` / `DO $$ EXCEPTION` /
  `CREATE OR REPLACE` / `cron.schedule` 上書き で**再実行安全**（実測確認済み）
- **例外は 00015 のみ。** Q6が「適用済み」なら、上記のガード修正を先に入れる
- 00016 は Q7 の重複チェックが 0行であることを確認してから
- 修復経路: **00015 ガード修正 → 選択肢1（CI repair step）→ push**
- 注意: push 成功後は履歴と実スキーマが初めて一致する。以降は通常運用に戻る

### 分岐C: 旧スキーマが残存（Q3で「旧スキーマ: 残存」が1件以上）

**このまま push してはいけない。** 2つの機構が旧テーブルと衝突する。

1. **00013 が確実に失敗する。** `00013_enable_rls_all.sql` は
   `pg_tables WHERE schemaname='public' AND tablename NOT IN ('connector_limits')` を
   走査し、RLS未有効のテーブルが1つでもあれば
   `RAISE EXCEPTION 'RLS not enabled on table: %'` で中断する。
   旧テーブルのRLSが無効なら、push は 00013 で必ず止まる
   （00001〜00012 はコミット済みで残る＝**部分適用状態**になる）。
2. **00014 が旧テーブルの権限を広げる。** `ON ALL TABLES IN SCHEMA public` により
   旧テーブルにも `anon` SELECT が付与される。RLS未有効の旧テーブルがあれば
   匿名読み取りが可能になる。

- 取るべき順序:
  1. 旧スキーマを**どうするか**を先に決める（削除 / 別スキーマへ退避 / RLS有効化して残置）。
     これは事業判断を含むため `docs/spec/07_open_items.md` 相当の扱い
  2. 決定後に、00013 の走査対象を新スキーマ12テーブルに限定するか、
     旧テーブルを public から外すかのどちらかで衝突を解消
  3. その後に分岐A/Bの手順へ合流
- **この分岐では選択肢1（CI repair step）を先に入れてはいけない。**
  履歴だけ直して push が通るようになると、上記1・2がそのまま本番で発火する

### 分岐D: Q1 に `00001`〜 の履歴がある / 孤児が3件以上

本書の前提（CI経由の適用ゼロ）が崩れている。**修復に進まず、Q1〜Q8 の全出力を添えて報告すること。**

---

## 追加で確認したい前提（分岐に関わらず）

Q5 の結果が「`pg_cron` / `pg_net` 無効」だった場合、これは 00018 の適用を**確実に止める**。
マイグレーション側に `CREATE EXTENSION` が無いため、拡張の有効化は Dashboard 側の
先行作業になる。分岐が決まる前でも、この1点は独立して確認・準備できる。

`docs/runbooks/2026-08-07_token-refresh-verification.md` はこの拡張有効化を
「トラブルシューティング」節でしか触れていない。本診断の結果次第で
同runbookの「前提確認」へ昇格させる（点検事項として記録）。

---

## 報告フォーマット（人間 → Claude）

Q1〜Q8 の出力をそのまま貼り付けてください。個々の値の解釈はこちらで行います。

- **秘密の値は貼らないこと。** 本書のクエリは設計上、トークン・鍵・
  `service_role_key` の値を返しません（Q4は権限の真偽値のみ）。
  想定外の列が出た場合は伏せてください。
