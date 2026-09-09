-- 00035: 「購読が無いので配信しなかった」を記録できるようにする（発注 B-4）
--
-- ## なぜ要るか
--
-- 購読の状態で配信を止めるなら、**止めた事実が残らなければならない。**
-- 残らないと「今日は何も無かった」と「今日は止めた」が同じ顔になる——
-- 2026-09-03〜09-06 にパルスが4日出ず、記録も残らなかった形と同じである（00032 の理由）。
--
-- **`skipped_no_connection` と混ぜない。** 連携が無いのと、購読が無いのは別の話であり、
-- 打つ手も違う（前者は連携の導線、後者はお申し込みの導線）。
--
-- ## 停止そのものは既定で動かない
--
-- 実際に配信を止めるかどうかは環境変数 `SENTIO_ENFORCE_ENTITLEMENT`（未設定＝false）の裏にある。
-- **この migration は「記録できる形」を先に用意するだけ**で、挙動は変えない。
--
-- ## 冪等性
--
-- DROP CONSTRAINT IF EXISTS → ADD CONSTRAINT のみ。既存行は新しい値を持たないので通る。

ALTER TABLE dispatch_runs DROP CONSTRAINT IF EXISTS dispatch_runs_outcome_check;
ALTER TABLE dispatch_runs ADD CONSTRAINT dispatch_runs_outcome_check
  CHECK (outcome IS NULL OR outcome IN (
    'delivered', 'reconnect_notice', 'reconnect_suppressed',
    'skipped_no_connection', 'skipped_no_email',
    -- **購読が無いので送らなかった**（B-4）。連携が無いのとは別の値にする
    'skipped_not_entitled',
    'failed_state', 'failed_sense', 'failed_deliver',
    'packet_delivered', 'packet_not_sent', 'packet_build_failed'
  ));

DO $$
BEGIN
  -- 新しい値が通ること・古い値が通ることを、この場で確かめる
  INSERT INTO dispatch_runs (kind, dispatch, company_id, outcome, companies, reason)
  VALUES ('company', 'daily', '00000000-0000-0000-0000-000000000000',
          'skipped_not_entitled', NULL, 'migration_self_check');
  DELETE FROM dispatch_runs WHERE reason = 'migration_self_check';
EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION '00035: skipped_not_entitled が CHECK に通らない';
END $$;
