-- 00029: 会社を引けなかった課金 webhook を残す最小テーブルと、Stripe customer からの逆引き（④-a）
--
-- ## なぜ要るか
--
-- webhook は会社を `object.client_reference_id` だけで引いていた。**これは Checkout Session
-- にしか無い。** 実物の `customer.subscription.*` の `data.object` は Subscription で、
-- そこに `client_reference_id` は無い。したがって**解約の通知は 200 で捨てられ、
-- 利用者が解約しても画面は「購読中」のまま残る。**
-- テストは、Subscription に `client_reference_id` を載せた作り物のフィクスチャで通っていた
-- （`tests/unit/billing-webhook.test.ts` の1つ前のコミットが、その形を実物に直して赤くしてある）。
--
-- ## 逆引きの材料は既にある（2026-09-07 実測）
--
-- `checkout/route.ts:42` が `client_reference_id` を渡し、webhook が受けた時点で
-- `stripe_customer_id` を `auth.users.raw_user_meta_data` に書いている。本番の実測は
-- `users_total 3 / subscription_rows 1 / missing_customer_id 0`。**欠落は0件。**
-- 足りないのは逆引きだけで、**バックフィルは要らない**（受入 5-2 は実測により取り下げ）。
--
-- ## 冪等性
--
-- CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION / 条件付きの GRANT のみ。再実行安全。

-- ---------------------------------------------------------------------------
-- 1. 引けなかったイベントを受ける最小テーブル（受入 5-3・改訂後）
--
-- **`delivery_log` には入れられない。** あちらは company_id が必須で、
-- 会社が引けなかった行はそもそも作れない。だから専用の表を置く。
--
-- **company_id を持たない。** これは省略ではなく、この表の存在理由そのものである
-- （会社が引けなかった事実を記録するための表なので、会社は書けない）。
-- その帰結として、この表は `check:deletion-coverage` の射程外になる
-- （あの検査器は company_id を持つ表だけを見る）。**アカウント削除でこの表の行は消えない。**
-- 残るのは Stripe の customer id と event id だけで、氏名・メール・金額・
-- ペイロード本体は入らない。**ペイロード全体を保存しない**のは、
-- ここが「捨てたことを黙らせない」ための表であって、再処理のための保管庫ではないからである。
--
-- 列の意味:
--   stripe_event_id     Stripe のイベントID。**これが冪等キーである**（同じ通知は再送されうる）
--   event_type          イベント種別（checkout.session.completed など）
--   reason              なぜ適用できなかったか。2値に固定する（下の CHECK が唯一の台帳）
--   stripe_customer_id  生の識別子。逆引きに失敗した値そのもの。**追跡の手掛かりはこれだけ**
--   created_at          受信時刻
--   resolved_at         人が対処し終えたら埋める。**集計は resolved_at IS NULL だけを数える**
--                       （埋める手順は docs/runbooks/2026-09-07_billing-webhook-unresolved.md）
--
-- resolved_at を持たないと、1件入った日から**毎日同じ通知が永久に出続ける。**
-- 鳴りっぱなしの通知は、鳴らない通知と同じくらい早く読まれなくなる。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_webhook_unresolved (
  stripe_event_id     TEXT PRIMARY KEY,
  event_type          TEXT NOT NULL,
  reason              TEXT NOT NULL,
  stripe_customer_id  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at         TIMESTAMPTZ
);

-- reason は自由文字列にしない。取りうる値は2つだけである。
--   company_unresolved   customer id から会社を引けなかった（0件 or 2件以上）
--   stripe_fetch_failed  会社は引けたが、Stripe から Subscription を取り直せなかった
-- 想定外の値を弾く（00024 の delivery_log_status_check と同じ作法）。
ALTER TABLE billing_webhook_unresolved DROP CONSTRAINT IF EXISTS billing_webhook_unresolved_reason_check;
ALTER TABLE billing_webhook_unresolved ADD CONSTRAINT billing_webhook_unresolved_reason_check
  CHECK (reason IN ('company_unresolved', 'stripe_fetch_failed'));

-- 索引は張らない。**この表に行が入るのは異常時だけ**で、全件走査で足りる。
-- 行が増え続ける状態そのものが異常なので、性能で隠さない。

-- ---------------------------------------------------------------------------
-- 2. RLS（CLAUDE.md 絶対規則「全テーブルRLS必須」）
--
-- **ポリシーを1本も張らない。** RLS 有効かつポリシー0本は「誰も読めない」を意味する。
-- 会社に紐づかない表なので `company_id = auth.uid()` は書きようがなく、
-- 利用者に見せるものでもない。service_role は RLS をバイパスするので webhook から書ける。
--
-- GRANT も service_role だけに出す（RLS の手前でもう一枚落とす）。
-- 00013 / 00014 の明示リストには**追記しない**。適用済みのマイグレーションを後から
-- 書き換えると本番履歴と食い違うためで、代わりに 00024 と同じく末尾で自表を検証する。
-- ---------------------------------------------------------------------------
ALTER TABLE billing_webhook_unresolved ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.billing_webhook_unresolved TO service_role;
REVOKE ALL ON public.billing_webhook_unresolved FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Stripe customer からの逆引き（受入 5-1 / 4-4）
--
-- **新しいテーブルは作らない。** 購読の正本は `auth.users.raw_user_meta_data.subscription`
-- で（BU-D2）、そこに `stripe_customer_id` が既に入っている。第2の台帳を作ると片方が古くなる。
--
-- `auth.users` は PostgREST から直接は引けないので、SECURITY DEFINER の関数を1本だけ置く。
--
-- **0件でも2件以上でも NULL を返す。** 当てずっぽうで1社に書くと、
-- 他社の購読状態を書き換える経路になる。曖昧なら書かず、上の表に残して人に渡す。
--
-- `search_path = ''` は SECURITY DEFINER の定石。参照は全て schema 修飾する。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.company_id_by_stripe_customer(p_customer_id TEXT)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ids UUID[];
BEGIN
  -- 空文字を渡すと「metadata に customer id が無いユーザー」と一致しうる。手前で切る
  IF p_customer_id IS NULL OR p_customer_id = '' THEN
    RETURN NULL;
  END IF;

  SELECT array_agg(u.id) INTO v_ids
    FROM auth.users u
   WHERE u.raw_user_meta_data -> 'subscription' ->> 'stripe_customer_id' = p_customer_id;

  IF v_ids IS NULL OR array_length(v_ids, 1) <> 1 THEN
    RETURN NULL;
  END IF;

  RETURN v_ids[1];
END;
$$;

-- **CREATE FUNCTION は既定で PUBLIC に EXECUTE を与える。** 剥がさないと、
-- ログイン済みの誰でも「customer id → 会社ID」を引ける経路になる。
REVOKE ALL ON FUNCTION public.company_id_by_stripe_customer(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.company_id_by_stripe_customer(TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.company_id_by_stripe_customer(TEXT) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. 検証（黙って適用されるのを許さない。00024 と同じ作法）
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_policies INT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'billing_webhook_unresolved' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION '00029: RLS not enabled on table: billing_webhook_unresolved';
  END IF;

  -- **0本であることを確かめる。** 後から誰かが公開ポリシーを足したら、ここで止める
  SELECT count(*) INTO v_policies
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'billing_webhook_unresolved';

  IF v_policies <> 0 THEN
    RAISE EXCEPTION '00029: billing_webhook_unresolved にポリシーが % 本ある（0本が正）', v_policies;
  END IF;

  -- anon / authenticated に権限が残っていないこと
  IF has_table_privilege('anon', 'public.billing_webhook_unresolved', 'SELECT')
     OR has_table_privilege('authenticated', 'public.billing_webhook_unresolved', 'SELECT') THEN
    RAISE EXCEPTION '00029: anon / authenticated に SELECT が残っている';
  END IF;

  IF NOT has_function_privilege('service_role', 'public.company_id_by_stripe_customer(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '00029: service_role が company_id_by_stripe_customer を実行できない';
  END IF;

  IF has_function_privilege('authenticated', 'public.company_id_by_stripe_customer(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '00029: authenticated から逆引き関数が実行できる（EXECUTE を剥がすこと）';
  END IF;
END $$;
