# 08 スキーマ骨子（DDLスケッチ・正本は実マイグレーション）

※実装時はこの骨子を出発点に、migration skillの手順で作成する。列の増減はspec更新とセット。

events(event_id text PK, company_id uuid NULL, occurred_at timestamptz, period_start/end timestamptz NULL,
ingested_at, source text, event_type text CHECK(8分類), actor_ref uuid NULL, entity_refs uuid[],
metrics jsonb, sensitivity text CHECK(S0-S3)) -- S2本文カラム禁止はallowlistで機械検査
entities(id, company_id, type, canonical_name, merge_keys jsonb, attrs jsonb, care_only bool default true,
first_seen, last_seen, retired_at NULL) -- 従業員は care_only=用途制限フラグ
baselines(id, company_id, metric_key, entity_id NULL, granularity, stats jsonb, min_obs int,
is_established bool, updated_at)
narratives(id, company_id, category, topic, content text, confidence numeric, source_event_ids text[],
last_confirmed_at, decayed_at)
company_summary(company_id PK, content text, token_count int, chapters jsonb, generated_at)
findings(id, company_id, status CHECK(open/watching/resolved/expired), urgency CHECK(immediate/weekly/monthly),
what text, evidence_event_ids text[], confidence, hypotheses jsonb, next_actions jsonb,
eval_log jsonb, parent_finding_id NULL, created_at, updated_at)
connections(id, company_id, provider, vault_secret_id uuid, scopes text[], status, last_refresh, expires_at)
connector_limits(provider PK, limits jsonb) -- レート制限レジストリ（宣言的）
known_explanations(id, company_id NULL, kind, period, source, auto bool)
misjudgments(id, company_id, finding_id, kind, detail, created_at) -- 誤判定追跡
delivery_log(id, company_id, frame CHECK(day0/pulse/alert/weekly/radar), finding_ids, sent_at, opened, acted)
budget_usage(company_id, date, full_runs int, light_runs int)
billing_webhook_events(stripe_event_id text PK, event_type text, processed_at timestamptz)
-- 処理済み webhook の台帳（00034）。**会社に紐づかない**。RLS 有効・ポリシー0本・service_role のみ

全テーブルRLS必須。events.event_id UNIQUE。index基本形 (company_id, occurred_at)。

## 権限（GRANT）の方針（00036・2026-09-09）

**RLS は「どの行か」を絞るだけで、「書いてよいか」は GRANT が決める。**
2026-09-09 の実測では `authenticated` が12表すべてに INSERT / UPDATE / DELETE を持っており、
**顧客が自社の `budget_usage` や `findings` を書き換えられた。**

- **読むだけ**（authenticated は SELECT のみ）:
  budget_usage / findings / misjudgments / baselines / narratives / company_summary /
  delivery_log / connection_events
- **書き込みを残す**（RLS クライアント経由の書き込みが実在する）:
  events / entities / connections
- **anon は公開スキーマの表に何も持たない**（未ログインに会社のデータは要らない）
- service_role のみ: billing_webhook_events / billing_webhook_unresolved /
  dispatch_runs / retention_purge_runs
