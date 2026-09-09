-- 00034: 処理済み webhook の台帳（発注 A-5）
--
-- ## なぜ要るか
--
-- **Stripe は同じイベントを何度も送る。** 送達が確認できなければ再送するのが仕様で、
-- 受け手が2回目を弾かなければ、同じ購読の更新が2回走る。
-- いまは `updateUserById` が冪等なので実害は出ていないが、
-- **A-7 のメール送信を webhook に足した時点で「2通目」になる。**
--
-- 台帳は**署名検証の直後**に書く。会社が引けたかどうかより前である——
-- 引けなかったイベントも「受け取った」ことは事実であり、再送のたびに
-- `billing_webhook_unresolved` へ同じ行を積み直す必要はない。
--
-- ## 権限（00029 の作法をそのまま踏む）
--
-- RLS 有効・**ポリシー0本**・anon/authenticated から REVOKE ALL・service_role のみ GRANT。
-- ポリシーが0本なら、RLS 下のロールからは1行も見えない（fail-closed）。
-- **これは会社に紐づかない表である**（`stripe_event_id` が主キー）。
--
-- ## 冪等性
--
-- CREATE TABLE IF NOT EXISTS / DROP POLICY IF EXISTS のみ。再実行安全。

CREATE TABLE IF NOT EXISTS billing_webhook_events (
  stripe_event_id TEXT PRIMARY KEY,
  event_type      TEXT NOT NULL,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 「いつ来たか」を新しい順に見る。台帳が伸びても直近だけを引ける
CREATE INDEX IF NOT EXISTS idx_billing_webhook_events_processed
  ON billing_webhook_events(processed_at DESC);

ALTER TABLE billing_webhook_events ENABLE ROW LEVEL SECURITY;

-- **ポリシーは作らない。** RLS 有効＋ポリシー0本＝anon/authenticated からは0行。
-- service_role は RLS を迂回する（Supabase の仕様）ので Edge / Route Handler からは読める

REVOKE ALL ON billing_webhook_events FROM anon, authenticated;
GRANT SELECT, INSERT ON billing_webhook_events TO service_role;

-- ---------------------------------------------------------------------------
-- 自表検証（00029 / 00030 と同じ作法）。**期待と違えば migration を失敗させる**
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF has_table_privilege('anon', 'billing_webhook_events', 'SELECT') THEN
    RAISE EXCEPTION '00034: anon が billing_webhook_events を SELECT できる';
  END IF;
  IF has_table_privilege('authenticated', 'billing_webhook_events', 'INSERT') THEN
    RAISE EXCEPTION '00034: authenticated が billing_webhook_events に INSERT できる';
  END IF;
  IF NOT has_table_privilege('service_role', 'billing_webhook_events', 'INSERT') THEN
    RAISE EXCEPTION '00034: service_role が billing_webhook_events に INSERT できない';
  END IF;
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'billing_webhook_events') <> 0 THEN
    RAISE EXCEPTION '00034: billing_webhook_events にポリシーがある（0本が要件）';
  END IF;
END $$;
