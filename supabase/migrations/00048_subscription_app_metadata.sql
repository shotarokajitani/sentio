-- 00048: 購読の置き場所を user_metadata から app_metadata へ移す（2026-09-13 の点検で見つかった欠陥）
--
-- ## 何が起きていたか
--
-- 購読の状態を `auth.users.raw_user_meta_data -> 'subscription'` に置いていた。
-- **Supabase Auth の仕様で、`user_metadata` は利用者本人が `auth.updateUser({ data })` で
-- 自由に書ける。** service_role 限定なのは `app_metadata` のほうである。
--
-- 書き換えられると次のことが起きた。
--
--   1. 購読していない会社が `status: "active"` を名乗り、LLM の枠（標準プラン）を使える
--   2. `stripe_customer_id` に**他社の `cus_`** を書くと、他社のカスタマーポータル
--      （請求書・支払い方法・解約）が開ける
--   3. `company_id_by_stripe_customer`（00029）が書き換えた値で会社を引き、
--      **他社の webhook を自社に紐づけうる**
--
-- ## 何をするか
--
--   1. `company_id_by_stripe_customer` を `raw_app_meta_data` から引く形に作り直す
--   2. 既存の購読（本番は1件）を `raw_user_meta_data` から**消す。写さない。**
--
-- **表を新設しない。** 形（plan_id / stripe_customer_id / stripe_subscription_id / status）も
-- 変えない。読み書きの場所を入れ替えるだけである。
--
-- ## 既存の1件を写さない理由（2026-09-13・検収者の判断 C）
--
-- 本番で `raw_user_meta_data` に購読を持っていたのは `197f2c0e…` の1件だけだった。
-- その `stripe_subscription_id`（`sub_1UBJ6IHh1zAdxqN6IOnxVhyr`）を **Stripe 本番（live）で
-- 照会すると `No such subscription` だった**（test mode には存在する）。
--
-- **本番に実体の無い値を、利用者が書き換えられない正本に昇格させない。**
-- 今回の欠陥の文脈では、この値が正規の webhook で書かれたのか `user_metadata` を
-- 書き換えられたのかを区別できない。正本を作れるのは Stripe の署名つき webhook だけにする。
--
-- この会社は `/connect` で「購読なし」（購読ボタンが出る）に変わる。**これが正しい。**
-- `SENTIO_ENFORCE_ENTITLEMENT` は false なので、配信は止まらない。
--
-- ## 冪等性
--
-- CREATE OR REPLACE FUNCTION / 条件付き UPDATE のみ。2回目は `? 'subscription'` が
-- 偽になり0件で終わる。再実行安全。

-- ---------------------------------------------------------------------------
-- 1. 会社の逆引きを app_metadata から引く
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.company_id_by_stripe_customer(p_customer_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ids UUID[];
  v_matches INT;
BEGIN
  -- 空文字を渡すと「metadata に customer id が無いユーザー」と一致しうる。手前で切る
  IF p_customer_id IS NULL OR p_customer_id = '' THEN
    RETURN jsonb_build_object('company_id', NULL, 'matches', 0);
  END IF;

  -- **`raw_app_meta_data` だけを見る**（00048）。`raw_user_meta_data` は利用者が書けるので、
  -- そこを見ると他社の customer id を名乗って webhook を自社に紐づけられる。
  -- **それ以外は 00029 と1文字も変えていない**（戻り値の形・2件一致の扱い）
  SELECT array_agg(u.id) INTO v_ids
    FROM auth.users u
   WHERE u.raw_app_meta_data -> 'subscription' ->> 'stripe_customer_id' = p_customer_id;

  v_matches := COALESCE(array_length(v_ids, 1), 0);

  -- **2件以上一致しても1件目に寄せない。** 00029 のまま、会社を引けなかったことにする
  IF v_matches <> 1 THEN
    RETURN jsonb_build_object('company_id', NULL, 'matches', v_matches);
  END IF;

  RETURN jsonb_build_object('company_id', v_ids[1], 'matches', 1);
END;
$$;

REVOKE ALL ON FUNCTION public.company_id_by_stripe_customer(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.company_id_by_stripe_customer(TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.company_id_by_stripe_customer(TEXT) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. 既存の購読を user_metadata から消す（本番は1件）。**写さない**
--
-- `raw_app_meta_data` には何も書かない。正本は Stripe の署名つき webhook が
-- 次に届いたときに `app_metadata` へ書く。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_removed INT;
BEGIN
  UPDATE auth.users
  SET raw_user_meta_data = raw_user_meta_data - 'subscription'
  WHERE raw_user_meta_data ? 'subscription';
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  RAISE NOTICE '00048: user_metadata の購読を消した（%件・app_metadata には写していない）', v_removed;
END $$;

-- ---------------------------------------------------------------------------
-- 自表検証。**期待と違えば migration を失敗させる**
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- user_metadata に購読が1件も残っていないこと
  IF EXISTS (SELECT 1 FROM auth.users WHERE raw_user_meta_data ? 'subscription') THEN
    RAISE EXCEPTION '00048: raw_user_meta_data に subscription が残っている';
  END IF;

  -- **user_metadata の他のキーを消していないこと。** `- 'subscription'` は1キーだけを消す。
  -- email / sub などが消えた行があれば、ログインや表示が壊れる
  IF EXISTS (
    SELECT 1 FROM auth.users
    WHERE raw_user_meta_data IS NOT NULL
      AND raw_user_meta_data = '{}'::jsonb
      AND email IS NOT NULL
      AND created_at < now() - interval '1 minute'
  ) THEN
    RAISE WARNING '00048: user_metadata が空になった行がある（email を持つのに）';
  END IF;

  -- 逆引きが authenticated から呼べないこと
  IF has_function_privilege('authenticated', 'public.company_id_by_stripe_customer(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '00048: authenticated が company_id_by_stripe_customer を呼べる';
  END IF;
END $$;
