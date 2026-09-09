-- 00033: 状態パケットの実行記録を dispatch_runs に載せる（発注書 ①-a の 12-1〜12-3）
--
-- ## なぜ要るか
--
-- パケットは**毎日1社1回**組む。組めなかった日・送らなかった日・送り損ねた日が
-- 区別できないと、**「今日は何も無かった」と「今日は壊れていた」が同じ顔になる。**
-- これは 2026-09-03〜09-06 にパルスが4日出ず記録も残らなかった形（00032 の理由）と同じである。
--
-- **新しい表を作らない。** 実行記録の置き場は `dispatch_runs` 1つに保つ。
-- 増やすのは `dispatch` の値1つと `outcome` の値3つだけである。
--
-- ## 冪等性
--
-- DROP CONSTRAINT IF EXISTS → ADD CONSTRAINT のみ。再実行安全。
-- 既存行は 'daily' / 'weekly' しか持たないので、CHECK を広げても既存行は通る。

-- ---------------------------------------------------------------------------
-- 1. dispatch に 'packet' を足す
--
-- `daily` / `weekly` は「全社に配る」実行だが、`packet` は**検収者1社にだけ出す**
-- （PS-S3 と同じ扱い）。同じ表に載せるのは、実行記録を1か所に保つためである。
-- ---------------------------------------------------------------------------
ALTER TABLE dispatch_runs DROP CONSTRAINT IF EXISTS dispatch_runs_dispatch_check;
ALTER TABLE dispatch_runs ADD CONSTRAINT dispatch_runs_dispatch_check
  CHECK (dispatch IN ('daily', 'weekly', 'packet'));

-- ---------------------------------------------------------------------------
-- 2. outcome に3つ足す
--
-- **「送らなかった」と「送り損ねた」と「そもそも組めなかった」を別の値にする。**
-- 1つにまとめた瞬間、この記録は「毎日1行あるが中身が読めないもの」になる。
--
--   packet_delivered     組めて、送れた
--   packet_not_sent      組めたが送らなかった（既に同じ日のぶんを送っている＝冪等キーの衝突）
--   packet_build_failed  **組めなかった**（読み取りに失敗した。HTTP 200 で終わらせない）
--
-- `_shared/dispatch.ts` の CompanyOutcome と同じ集合である。片方を変えたら両方変える。
-- ---------------------------------------------------------------------------
ALTER TABLE dispatch_runs DROP CONSTRAINT IF EXISTS dispatch_runs_outcome_check;
ALTER TABLE dispatch_runs ADD CONSTRAINT dispatch_runs_outcome_check
  CHECK (outcome IS NULL OR outcome IN (
    'delivered', 'reconnect_notice', 'reconnect_suppressed',
    'skipped_no_connection', 'skipped_no_email',
    'failed_state', 'failed_sense', 'failed_deliver',
    'packet_delivered', 'packet_not_sent', 'packet_build_failed'
  ));
