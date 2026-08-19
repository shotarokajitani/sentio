-- 00024: delivery_log に冪等キー・再試行回数・状態のCHECKを足す（契約 S-2-7 / S-2-8）
--
-- 目的は二重送信の防止である。修復前は「Resend へ送信 → delivery_log へ INSERT」の順で、
-- **送信後のDB書き込みが失敗すると痕跡が何も残らなかった**（deliver-pulse/index.ts:98,127）。
-- その状態で再試行すると、DBには何も無いので2通目が出る。
-- 順序を「予約（INSERT）→ 送信 → 結果で UPDATE」に反転させると、
-- 「送ったかどうか分からない」状態が必ずDBに残り、判断の材料が消えない。
--
-- `sending` を「送っていない」ではなく「**送った可能性がある**」と解釈するのは、
-- 二重送信より未送信のほうが害が小さいという判断による
-- （Sentio は何も勝手に送らない。CLAUDE.md 絶対規則）。
--
-- 新テーブルは作らない。`delivery_log` は 00009 で company_id を持ち、
-- 00013（RLS有効）/ 00019（操作別ポリシー＋WITH CHECK）/ 00014（GRANT）で
-- 既に company_id = auth.uid() に閉じている。列追加だけで足りる。
-- それでも末尾でRLSを再アサートする（列を足すときに一緒に見る癖をここで固定する）。
--
-- 冪等性: ADD COLUMN IF NOT EXISTS / CREATE UNIQUE INDEX IF NOT EXISTS /
--         DROP CONSTRAINT IF EXISTS → ADD CONSTRAINT / 条件付き UPDATE のみ。再実行安全。

-- ---------------------------------------------------------------------------
-- 1. alert_deferred の廃止（契約 S-2-7 の条件）
--
-- 静音時間の繰り延べ行と、その後の実送信行は **同じ冪等キーを共有する必要がある**。
-- 別の delivery_type で別行にすると、送信時の予約 INSERT が一意制約違反になる。
-- したがって delivery_type は 'alert' に寄せ、繰り延べは status = 'deferred' で表す。
--
-- 参照箇所は書き込み1箇所のみで、読む側は存在しない（2026-08-19 実測）。
-- 本番に該当行があるかは deploy ログの NOTICE で分かる（0件なら no-op）。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  moved INT;
BEGIN
  UPDATE delivery_log
     SET delivery_type = 'alert',
         status = 'deferred'
   WHERE delivery_type = 'alert_deferred';

  GET DIAGNOSTICS moved = ROW_COUNT;
  RAISE NOTICE '00024: alert_deferred から移行した行数 = %', moved;
END $$;

-- ---------------------------------------------------------------------------
-- 2. 冪等キー
--
-- **単一の TEXT カラムに UNIQUE**。複合キーにしない。
-- 対象の次元（会社・種別・対象期間 or 対象ID）はキー文字列の中に畳み込む。
-- 組み立ては supabase/functions/_shared/delivery.ts の deliveryKey() が唯一の出所。
--
-- 部分索引にしていないのは、PostgreSQL の UNIQUE が既定で **NULLS DISTINCT** だから。
-- 既存行（冪等キーを持たない過去の配信ログ）は NULL のまま何行でも共存できる。
-- ---------------------------------------------------------------------------
ALTER TABLE delivery_log ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_log_idempotency_key
  ON delivery_log(idempotency_key);

-- ---------------------------------------------------------------------------
-- 3. 再試行回数
--
-- `failed`（Resend が明示的に失敗を返した＝送っていないと確定できる）だけが再試行できる。
-- 上限は supabase/functions/_shared/delivery.ts の MAX_SEND_ATTEMPTS に置く
-- （予算上限 MAX_FULL_RUNS_PER_DAY と同じ作法。環境変数化しない）。
-- **上限に達したら黙って止まらず、その事実をレコードとレスポンスに残す。**
-- ---------------------------------------------------------------------------
ALTER TABLE delivery_log ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 4. status を自由文字列にしない
--
-- 取りうる値は7つ。出所は 2026-08-19 の実測（Edge Function が delivery_log.status に
-- 書いている値の全数）＋ 本スライスで足す 'sending'。
--
--   sending   予約済み・送信中。**送ったかどうか分からない**（再送しない）
--   sent      送信成功（Resend が id を返した）
--   failed    送信失敗（Resend が明示的に失敗を返した）。再試行可
--   skipped   宛先が無く送っていない（内容は生成済み）
--   deferred  静音時間で繰り延べ（deliver-alert）
--   draft     ワンタップの下書き（onetap-calendar・送信しない）
--   confirmed ワンタップの下書きを確定（onetap-calendar・送信しない）
--
-- CHECK は NULL に対して true でも false でもない（＝素通りする）ため、
-- NOT NULL を併せて掛ける。掛けないと「NULL なら何でも通る」穴が残る。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  unknown_values TEXT;
  nulls INT;
BEGIN
  -- 想定外の値が本番に居たら、静かに落とさず**デプロイを止めて顕在化させる**。
  -- CHECK を後付けするときに既存行を黙って無視すると、制約があるのに実態は
  -- 守られていない状態になる（00013 と同じ fail-closed の作法）。
  SELECT string_agg(DISTINCT status, ', ')
    INTO unknown_values
    FROM delivery_log
   WHERE status IS NOT NULL
     AND status NOT IN ('sending', 'sent', 'failed', 'skipped', 'deferred', 'draft', 'confirmed');

  IF unknown_values IS NOT NULL THEN
    RAISE EXCEPTION '00024: delivery_log.status に想定外の値がある: %', unknown_values;
  END IF;

  -- 00015 が status を DEFAULT sent 付きで追加しているため、既存行は sent で
  -- 埋まっているはず。明示的に null を入れた行だけがここに来る
  UPDATE delivery_log SET status = 'sent' WHERE status IS NULL;
  GET DIAGNOSTICS nulls = ROW_COUNT;
  RAISE NOTICE '00024: status が NULL だった行を sent に埋めた行数 = %', nulls;
END $$;

ALTER TABLE delivery_log ALTER COLUMN status SET NOT NULL;

ALTER TABLE delivery_log DROP CONSTRAINT IF EXISTS delivery_log_status_check;
ALTER TABLE delivery_log ADD CONSTRAINT delivery_log_status_check
  CHECK (status IN ('sending', 'sent', 'failed', 'skipped', 'deferred', 'draft', 'confirmed'));

-- 冪等キーで引く経路（予約の衝突時に既存行を読む）に索引が要る。
-- 上の UNIQUE 索引がそのまま使えるので追加はしない。

-- ---------------------------------------------------------------------------
-- 5. RLS の再アサート
--
-- 新テーブルではないので 00013 のリスト追記は不要だが、
-- 「列を足したのに RLS を見ていない」を作らないため、ここで1回確かめる。
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'delivery_log' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION '00024: RLS not enabled on table: delivery_log';
  END IF;

  -- 00019 が張った操作別ポリシー4本が居ること（company_id = auth.uid()）
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'delivery_log') < 4 THEN
    RAISE EXCEPTION '00024: delivery_log のRLSポリシーが4本未満（00019 の適用漏れを疑う）';
  END IF;
END $$;
