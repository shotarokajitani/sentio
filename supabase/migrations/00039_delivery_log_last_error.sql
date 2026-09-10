-- 00039: delivery_log に「なぜ送れなかったか」を残す列を足す（発注 A-1 / B-1）
--
-- ## なぜ要るか
--
-- **送れなかった理由が、いまはどこにも残らない。**
-- `status = 'failed'` は「失敗した」しか言わず、`content` の jsonb に
-- `send_error` を入れている経路が1つあるだけで、**規則になっていない。**
--
-- 直したい形は2つある。
--
--   `mail_config_missing`  Next 側に RESEND_API_KEY / RESEND_FROM が無く、送らずに終わった
--   `stale_sending`        `sending` のまま2時間以上動かず、掃除で倒した行
--
-- どちらも **「0件だった」と「一度も試していない」を区別する**ために要る。
-- ログにしか出していないと、Vercel のログが流れた時点で分からなくなる。
--
-- ## 列を足すだけにする
--
-- `attempts` は既にある（00024）。再送の上限はこの列で数えるので**新しい列は足さない**。
-- `content` の jsonb に押し込まないのは、**理由で絞り込みたいから**である
-- （`WHERE last_error = 'stale_sending'` が引けないと、掃除の効き目を数えられない）。
--
-- ## 冪等性
--
-- ADD COLUMN IF NOT EXISTS のみ。再実行安全。

ALTER TABLE delivery_log ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE delivery_log ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ;

-- **理由で引けるようにする。** 掃除が何件倒したかを数えるのに使う
CREATE INDEX IF NOT EXISTS idx_delivery_log_last_error
  ON delivery_log(last_error)
  WHERE last_error IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 自表検証。**期待と違えば migration を失敗させる**
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  c TEXT;
BEGIN
  FOREACH c IN ARRAY ARRAY['last_error', 'last_error_at'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'delivery_log' AND column_name = c
    ) THEN
      RAISE EXCEPTION '00039: delivery_log.% が無い', c;
    END IF;

    -- **NULL 可であること。** 既存行に理由は無い。NOT NULL にすると適用が落ちる
    IF (
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'delivery_log' AND column_name = c
    ) <> 'YES' THEN
      RAISE EXCEPTION '00039: delivery_log.% が NOT NULL になっている', c;
    END IF;
  END LOOP;

  -- **書き込みは service_role だけ。** 00036 で delivery_log は読むだけの表にした。
  -- 列を足したことで権限が戻っていないことを、ここでも見る
  IF has_table_privilege('authenticated', 'delivery_log', 'UPDATE') THEN
    RAISE EXCEPTION '00039: authenticated が delivery_log を更新できる';
  END IF;
END $$;
