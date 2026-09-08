-- 00032: 送らなかった日を残す（PS-8）／連携の遷移を残す（PS-9）
--
-- ## なぜ要るか（2026-09-03〜09-06 の実物）
--
-- **毎朝のパルスが4日間1通も出ず、その事実がどこにも残らなかった。**
-- cron は毎日 succeeded、`dispatch-daily` は 200 を返していた。
--   取り消し → sync 対象外 → イベント無し → 0社 → **無記録**
-- 集計は応答本文に載るだけで、`net._http_response` は `pg_net.ttl = 6 hours` で消える。
-- **「何も無かった」と「何も起きなかった」が同じ 200 になっていた。**
--
-- ## 冪等性
--
-- CREATE TABLE IF NOT EXISTS / DROP CONSTRAINT IF EXISTS → ADD CONSTRAINT のみ。再実行安全。

-- ---------------------------------------------------------------------------
-- 1. dispatch_runs — 配信の実行記録（PS-8 / 改訂後の PS-5）
--
-- **異常の有無に関わらず、毎日1行の実行記録が残る**（`kind='run'`）。
-- 配信したかどうかは記録の**中身**で区別する。走査0件の日は `companies = 0` と書く。
-- `retention_purge_runs`（00030）と同じ形にしてある——
-- 実行そのものの行は会社に紐づかないので `company_id` は NULL 可、
-- ただし **NULL でよいのは `kind='run'` だけ**。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dispatch_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- run: 実行そのもの（0社でも必ず1行）/ company: 会社ごとの結末
  kind        TEXT NOT NULL,
  dispatch    TEXT NOT NULL,
  company_id  UUID,
  -- 会社ごとの結末。**「送らなかった」と「送り損ねた」を別の値にする**
  outcome     TEXT,
  -- kind='run' のときの対象会社数。**0 を書く**（0件は正常系であって、無記録ではない）
  companies   INT,
  -- 抑制・スキップの理由。自由記述にしない
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE dispatch_runs DROP CONSTRAINT IF EXISTS dispatch_runs_kind_check;
ALTER TABLE dispatch_runs ADD CONSTRAINT dispatch_runs_kind_check
  CHECK (kind IN ('run', 'company'));

ALTER TABLE dispatch_runs DROP CONSTRAINT IF EXISTS dispatch_runs_dispatch_check;
ALTER TABLE dispatch_runs ADD CONSTRAINT dispatch_runs_dispatch_check
  CHECK (dispatch IN ('daily', 'weekly'));

-- outcome の集合は `_shared/dispatch.ts` の CompanyOutcome と**同じもの**である。
-- 片方を変えたら両方変える（`DELIVERY_STATUSES` と 00024 の関係と同じ作法）。
--   delivered              配信した
--   reconnect_notice       再連携のお願いを送った（PS-9）
--   reconnect_suppressed   **送らなかった**（7日以内に送っている）
--   skipped_no_connection  連携が無い
--   skipped_no_email       宛先が取れない
--   failed_state / failed_sense / failed_deliver   **送り損ねた**
ALTER TABLE dispatch_runs DROP CONSTRAINT IF EXISTS dispatch_runs_outcome_check;
ALTER TABLE dispatch_runs ADD CONSTRAINT dispatch_runs_outcome_check
  CHECK (outcome IS NULL OR outcome IN (
    'delivered', 'reconnect_notice', 'reconnect_suppressed',
    'skipped_no_connection', 'skipped_no_email',
    'failed_state', 'failed_sense', 'failed_deliver'
  ));

-- **会社ごとの行に company_id が無い、を許さない。** NULL でよいのは実行の記録だけ
ALTER TABLE dispatch_runs DROP CONSTRAINT IF EXISTS dispatch_runs_shape_check;
ALTER TABLE dispatch_runs ADD CONSTRAINT dispatch_runs_shape_check
  CHECK (
    (kind = 'run'     AND company_id IS NULL     AND companies IS NOT NULL AND outcome IS NULL)
    OR
    (kind = 'company' AND company_id IS NOT NULL AND companies IS NULL     AND outcome IS NOT NULL)
  );

-- 「その日どうだったか」を引く索引。実行の行だけを新しい順に見る
CREATE INDEX IF NOT EXISTS idx_dispatch_runs_run
  ON dispatch_runs(created_at DESC)
  WHERE kind = 'run';

-- ---------------------------------------------------------------------------
-- 2. connection_events — 連携の遷移（PS-9）
--
-- **`connections` は現在の状態しか持たない。** `revoked_at` は再連携で NULL に戻るので、
-- **取り消しがあった事実そのものが消える**（2026-09-03 の取り消しは、09-07 の再連携で
-- DB から消えた。残っていたのはセッション記録とログだけだった）。
-- 遷移を残す表をここに置く。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connection_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID NOT NULL,
  provider     TEXT NOT NULL,
  -- 遷移元は分からないことがある（初回・履歴が無い）ので NULL 可
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  reason       TEXT NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE connection_events DROP CONSTRAINT IF EXISTS connection_events_status_check;
ALTER TABLE connection_events ADD CONSTRAINT connection_events_status_check
  CHECK (
    (from_status IS NULL OR from_status IN ('active', 'revoked', 'reauth_required', 'pending'))
    AND to_status IN ('active', 'revoked', 'reauth_required', 'pending')
  );

-- 理由も固定値。`invalid_grant` と「更新に失敗した」を混ぜない——**対処が違う**
ALTER TABLE connection_events DROP CONSTRAINT IF EXISTS connection_events_reason_check;
ALTER TABLE connection_events ADD CONSTRAINT connection_events_reason_check
  CHECK (reason IN ('invalid_grant', 'refresh_failed', 'vault_destroy_failed', 'reconnected'));

-- 「この会社にいつ何が起きたか」を新しい順に引く
CREATE INDEX IF NOT EXISTS idx_connection_events_company
  ON connection_events(company_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- 3. RLS（`00029` と同じ形。CLAUDE.md 絶対規則）
--
-- **ポリシーは張らない。GRANT は service_role だけ。**
-- 連携の失敗理由も、送らなかった理由も、**利用者に見せる情報ではない**。
-- ---------------------------------------------------------------------------
ALTER TABLE dispatch_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_events ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.dispatch_runs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.connection_events TO service_role;
REVOKE ALL ON public.dispatch_runs FROM anon, authenticated;
REVOKE ALL ON public.connection_events FROM anon, authenticated;

DO $$
DECLARE
  t TEXT;
  v_rls BOOLEAN;
  v_policies INT;
BEGIN
  FOREACH t IN ARRAY ARRAY['dispatch_runs', 'connection_events'] LOOP
    SELECT c.relrowsecurity INTO v_rls
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = t;

    RAISE NOTICE '00032: %.relrowsecurity = %', t, v_rls;

    IF v_rls IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION '00032: RLS not enabled on table: %', t;
    END IF;

    SELECT count(*) INTO v_policies
      FROM pg_policies WHERE schemaname = 'public' AND tablename = t;

    IF v_policies <> 0 THEN
      RAISE EXCEPTION '00032: % にポリシーが % 本ある（0本が正）', t, v_policies;
    END IF;

    IF has_table_privilege('anon', format('public.%I', t), 'SELECT')
       OR has_table_privilege('authenticated', format('public.%I', t), 'SELECT') THEN
      RAISE EXCEPTION '00032: % で anon / authenticated に SELECT が残っている', t;
    END IF;
  END LOOP;
END $$;
