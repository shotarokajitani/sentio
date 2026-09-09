-- 00041: delivery_log の status に `abandoned` を足す（発注 B-3）
--
-- ## なぜ要るか
--
-- 再送の上限（3回）に達した行を `failed` のまま置くと、**毎朝拾われ続ける。**
-- `RETRYABLE = ['failed', 'deferred']`（`_shared/delivery.ts`）に当たるので、
-- ディスパッチャは毎回この行を対象に入れ、`deliverOnce` が上限で弾く。
-- **「諦めた」ことがどこにも残らず、拾っては捨てるだけの往復が続く。**
--
-- 状態として分けると、
--
--   1. 拾われなくなる（`RETRYABLE` に入らない）
--   2. `WHERE status = 'abandoned'` で件数を数えられる（翌朝の要約に出す）
--
-- ## `skipped` を流用しない
--
-- `skipped` は「送る条件を満たさなかった」であって「送ろうとして駄目だった」ではない。
-- 混ぜると、**連携が無くて送らなかった会社と、3回落ちた会社が同じ顔になる。**
--
-- ## 冪等性
--
-- DROP CONSTRAINT IF EXISTS → ADD CONSTRAINT のみ。再実行安全。

ALTER TABLE delivery_log DROP CONSTRAINT IF EXISTS delivery_log_status_check;
ALTER TABLE delivery_log ADD CONSTRAINT delivery_log_status_check
  CHECK (status IN ('sending', 'sent', 'failed', 'skipped', 'deferred', 'draft',
                    'confirmed', 'abandoned'));

-- ---------------------------------------------------------------------------
-- 自表検証。**期待と違えば migration を失敗させる**
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_company UUID := '00000000-0000-0000-0000-000000000000';
BEGIN
  -- `abandoned` が通ること
  BEGIN
    INSERT INTO delivery_log (company_id, channel, delivery_type, status)
    VALUES (v_company, 'email', 'migration_self_check', 'abandoned');
    DELETE FROM delivery_log
      WHERE company_id = v_company AND delivery_type = 'migration_self_check';
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION '00041: abandoned が CHECK に入っていない';
  END;

  -- **知らない値は通らないこと。** CHECK を広げすぎていないかを見る
  BEGIN
    INSERT INTO delivery_log (company_id, channel, delivery_type, status)
    VALUES (v_company, 'email', 'migration_self_check', 'bogus');
    DELETE FROM delivery_log
      WHERE company_id = v_company AND delivery_type = 'migration_self_check';
    RAISE EXCEPTION '00041: status に知らない値が入った（CHECK が効いていない）';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END $$;
