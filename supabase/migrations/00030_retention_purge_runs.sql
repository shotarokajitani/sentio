-- 00030: 削除の実行記録（契約D の D-3・発注2 の受入基準）
--
-- **「実行のたびに、対象件数 / 実削除件数 / 判定を記録に残す」**ための表。
-- ログだけでは足りない。Vercel も Supabase もログの保持は有限で、
-- **「いつ・どの会社の・何件を・消したのか／止めたのか」は後から辿れる必要がある**
-- （privacy §6 で公開した削除の約束が、実際に果たされたことの証跡になる）。
--
-- 上限に当たって止めた事実も**同じ表に残す**（`decision = 'blocked'`）。
-- 止めたことがログにしか無いと、翌日には誰も気づけない。
--
-- ## **実行のたびに必ず1行入る**（`kind = 'run'`）
--
-- 対象が0件でも、実行そのものの記録を1行残す。**これが無いと
-- 「0件だったから記録が無い」と「cron が発火していないから記録が無い」が同じ顔になる。**
-- 今日ふさいだ「実装はあるが動いていない」4件のうち、`retention-purge` はまさに
-- 「cron が無くて一度も動いていなかった」件である。**動いた証跡そのものを残す。**
--
-- ## company_id を持つ
--
-- `billing_webhook_unresolved`（00029）と違い、**この表は会社に紐づく。**
-- したがって `check:deletion-coverage` の対象であり、
-- アカウント削除の手順書に DELETE を足してある（既定は削除）。
--
-- ## 冪等性
--
-- CREATE TABLE IF NOT EXISTS / DROP CONSTRAINT IF EXISTS → ADD CONSTRAINT のみ。再実行安全。

CREATE TABLE IF NOT EXISTS retention_purge_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- **`kind = 'run'` の行だけ NULL。** 実行そのものの記録は会社に紐づかない
  company_id  UUID,
  -- どの削除か。24ヶ月の保持期限と、取り消しから30日は**別の削除**である。
  -- `run` は**実行そのもの**の記録で、対象が0件でも必ず1行入る（下記）
  kind        TEXT NOT NULL,
  -- revoked_grace のときだけ入る。どの連携由来の source を消したかの手掛かり
  provider    TEXT,
  -- 対象として数えた件数。**実削除件数ではない**
  counted     INT NOT NULL,
  -- 実際に消した件数。dry_run と blocked では 0 になる
  deleted     INT NOT NULL,
  decision    TEXT NOT NULL,
  -- blocked のときだけ入る（unscoped / uncounted / over-limit / unknown-provider）
  reason      TEXT,
  -- **この実行が数えるだけだったか。** 既定を安全側に倒した結果がここに残る
  dry_run     BOOLEAN NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 値を自由文字列にしない（00024 / 00029 と同じ作法）。
-- decision と PurgePlan（_shared/retention.ts）の集合は**同じもの**である。片方を変えたら両方変える。
ALTER TABLE retention_purge_runs DROP CONSTRAINT IF EXISTS retention_purge_runs_kind_check;
ALTER TABLE retention_purge_runs ADD CONSTRAINT retention_purge_runs_kind_check
  CHECK (kind IN ('run', 'retention_months', 'revoked_grace'));

-- **会社ごとの行に company_id が無い、を許さない。** NULL でよいのは実行の記録だけである
ALTER TABLE retention_purge_runs DROP CONSTRAINT IF EXISTS retention_purge_runs_company_check;
ALTER TABLE retention_purge_runs ADD CONSTRAINT retention_purge_runs_company_check
  CHECK ((kind = 'run' AND company_id IS NULL) OR (kind <> 'run' AND company_id IS NOT NULL));

ALTER TABLE retention_purge_runs DROP CONSTRAINT IF EXISTS retention_purge_runs_decision_check;
ALTER TABLE retention_purge_runs ADD CONSTRAINT retention_purge_runs_decision_check
  CHECK (decision IN ('deleted', 'dry_run', 'nothing', 'blocked'));

ALTER TABLE retention_purge_runs DROP CONSTRAINT IF EXISTS retention_purge_runs_reason_check;
ALTER TABLE retention_purge_runs ADD CONSTRAINT retention_purge_runs_reason_check
  CHECK (reason IS NULL OR reason IN ('unscoped', 'uncounted', 'over-limit', 'unknown-provider'));

-- 「止めた行」を先に見たい。**異常だけを引く索引**にする（全件走査させない）
CREATE INDEX IF NOT EXISTS idx_retention_purge_runs_blocked
  ON retention_purge_runs(created_at DESC)
  WHERE decision = 'blocked';

-- ---------------------------------------------------------------------------
-- RLS（CLAUDE.md 絶対規則）
--
-- **ポリシーは張らない。** これは運用の証跡であって、利用者に見せるものではない。
-- service_role は RLS をバイパスするので Edge Function から書ける。
-- GRANT も service_role だけに出し、RLS の手前でもう一枚落とす（00029 と同じ）。
-- ---------------------------------------------------------------------------
ALTER TABLE retention_purge_runs ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.retention_purge_runs TO service_role;
REVOKE ALL ON public.retention_purge_runs FROM anon, authenticated;

DO $$
DECLARE
  v_rls BOOLEAN;
  v_policies INT;
BEGIN
  SELECT c.relrowsecurity INTO v_rls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'retention_purge_runs';

  RAISE NOTICE '00030: retention_purge_runs.relrowsecurity = %', v_rls;

  IF v_rls IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION '00030: RLS not enabled on table: retention_purge_runs';
  END IF;

  SELECT count(*) INTO v_policies
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'retention_purge_runs';

  IF v_policies <> 0 THEN
    RAISE EXCEPTION '00030: retention_purge_runs にポリシーが % 本ある（0本が正）', v_policies;
  END IF;

  IF has_table_privilege('anon', 'public.retention_purge_runs', 'SELECT')
     OR has_table_privilege('authenticated', 'public.retention_purge_runs', 'SELECT') THEN
    RAISE EXCEPTION '00030: anon / authenticated に SELECT が残っている';
  END IF;
END $$;
