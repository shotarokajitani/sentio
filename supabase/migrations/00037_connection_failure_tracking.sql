-- 00037: 一時的な失敗と、本当に切れたのを分ける（発注 ①-2）
--
-- ## なぜ要るか（2026-09-09 の実測）
--
-- **ネットワークが1回瞬断しただけで、顧客の連携が「切れた」ことになる。**
--
--   1. `classifyTokenFailure` は `status !== 400` を**すべて** `reauth_required` にする
--      （`_shared/token-refresh.ts:62`）。408・429・5xx が全部ここに落ちる。
--      fetch の例外・Vault の読み取り失敗・Vault の中身の破損は、
--      分類器を通らずに直接 `markReauthRequired` を呼ぶ（同 129 / 142 / 160 行）
--   2. `sync-connections` は `status = 'active'` だけを拾う（同 index.ts:59）。
--      **一度倒れた行は cron から二度と触られない**
--   3. `dispatch` は `reauth_required` を「再連携のお願い」の対象にする
--      （`_shared/dispatch.ts:116`）。7日ごとに顧客へ届く
--
-- **1回の瞬断が、顧客が手で再連携するまで直らない状態を作る。**
--
-- ## 何を足すか
--
--   consecutive_failures  一時的な失敗の連続回数。**3 で `reauth_required` に倒す**
--   last_failure_at       最後に失敗した時刻。`reauth_required` の再試行を1日1回に絞る
--
-- どちらも既定値を持つので、既存行はそのまま通る。
--
-- ## 冪等性
--
-- ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS → ADD CONSTRAINT のみ。再実行安全。

-- ---------------------------------------------------------------------------
-- 1. 失敗の連続回数と、最後に失敗した時刻
-- ---------------------------------------------------------------------------
ALTER TABLE connections
  ADD COLUMN IF NOT EXISTS consecutive_failures INT NOT NULL DEFAULT 0;

ALTER TABLE connections
  ADD COLUMN IF NOT EXISTS last_failure_at TIMESTAMPTZ;

-- 「再試行してよい `reauth_required` の行」を引く索引。
-- 1日1回に絞るので、`last_failure_at` の古い順に見る
CREATE INDEX IF NOT EXISTS idx_connections_retry
  ON connections(status, last_failure_at)
  WHERE status = 'reauth_required';

-- ---------------------------------------------------------------------------
-- 2. `connection_events.reason` に `recovered` を足す
--
-- **「再連携された」と「勝手に直った」は別の出来事である。**
-- `reconnected` は人が画面から繋ぎ直したとき、`recovered` は
-- 一時的な失敗が収まって cron が自動で戻したときに使う。
-- 混ぜると「顧客が何かしたのか、放っておいて直ったのか」が読めなくなる。
-- ---------------------------------------------------------------------------
ALTER TABLE connection_events DROP CONSTRAINT IF EXISTS connection_events_reason_check;
ALTER TABLE connection_events ADD CONSTRAINT connection_events_reason_check
  CHECK (reason IN ('invalid_grant', 'refresh_failed', 'vault_destroy_failed',
                    'reconnected', 'recovered'));

-- ---------------------------------------------------------------------------
-- 3. `dispatch_runs.outcome` に `skipped_ended` を足す（発注 ⑦-D-4 の同梱ぶん）
--
-- 配信終了メールを出したあとの日を、**「購読が無い」とも「連携が無い」とも別の値**にする。
-- 打つ手が違う（前者はお申し込みの導線、後者は連携の導線、これは**何も出さないのが正しい**）。
-- メール本体は別 PR で入る。**記録できる形を先に用意する。**
-- ---------------------------------------------------------------------------
ALTER TABLE dispatch_runs DROP CONSTRAINT IF EXISTS dispatch_runs_outcome_check;
ALTER TABLE dispatch_runs ADD CONSTRAINT dispatch_runs_outcome_check
  CHECK (outcome IS NULL OR outcome IN (
    'delivered', 'reconnect_notice', 'reconnect_suppressed',
    'skipped_no_connection', 'skipped_no_email',
    'skipped_not_entitled', 'skipped_ended',
    'failed_state', 'failed_sense', 'failed_deliver',
    'packet_delivered', 'packet_not_sent', 'packet_build_failed'
  ));

-- ---------------------------------------------------------------------------
-- 4. 自表検証
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- 4-1. 列が在り、既定値が入ること
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'connections'
      AND column_name = 'consecutive_failures' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION '00037: connections.consecutive_failures が NOT NULL で存在しない';
  END IF;

  -- 4-2. `recovered` が通ること
  BEGIN
    INSERT INTO connection_events (company_id, provider, from_status, to_status, reason)
    VALUES ('00000000-0000-0000-0000-000000000000', 'migration_self_check',
            'reauth_required', 'active', 'recovered');
    DELETE FROM connection_events WHERE provider = 'migration_self_check';
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION '00037: recovered が CHECK に通らない';
  END;

  -- 4-3. `skipped_ended` が通ること
  BEGIN
    INSERT INTO dispatch_runs (kind, dispatch, company_id, outcome, companies, reason)
    VALUES ('company', 'daily', '00000000-0000-0000-0000-000000000000',
            'skipped_ended', NULL, 'migration_self_check');
    DELETE FROM dispatch_runs WHERE reason = 'migration_self_check';
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION '00037: skipped_ended が CHECK に通らない';
  END;
END $$;
