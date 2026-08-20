-- 00026: retention_expired_companies — 保持期間を過ぎた行を持つ会社だけを列挙する
--
-- なぜ要るか:
--   retention-purge は「会社ごとに数えてから消す」形にしてある（消しすぎを止める門）。
--   そのためには会社の一覧が要るが、**この設計に会社テーブルは存在しない。**
--   `public.companies` は旧プロジェクト由来の遺物で 00021 で DROP 済みであり、
--   会社の同一性は `auth.users.id`（＝ RLS の `company_id = auth.uid()`）が担っている。
--   PostgREST から `auth` スキーマは引けない。
--
--   `events` から直接引く手もあるが、PostgREST に DISTINCT は無く、
--   既定の行数上限（1000）で**黙って打ち切られる**。打ち切られた分の会社は
--   一生purgeされないまま緑で終わる。「静かに漏れる」形は作らない。
--
-- なぜ対象を「期限切れの行を持つ会社」に絞るか:
--   全社を返すと、消すものが無い会社の分だけ空振りの count クエリが走る。
--   絞れば戻り値そのものが作業リストになる。
--
-- company_id IS NULL を除く理由:
--   NULLスコープ行は S0 の共有データ（00019 の allow_null_read）であって、
--   特定のお客様の Google ユーザーデータではない。会社単位の削除の対象外である。
--   除かないと `evaluateDeletion` が毎回 `unscoped` で1件ブロックし続け、
--   応答の `blocked` が常時1になって**異常の合図として使えなくなる**。
--
-- 権限: service_role のみ。SECURITY DEFINER は postgres 権限で走るため、
--   anon / authenticated から呼べると RLS を迂回して全社の company_id が読める。
--
-- LANGUAGE sql にしてあるのは、本文の列参照が **CREATE 時に検証される**ため
--   （check_function_bodies の既定は on）。列名を間違えたら CI の
--   `supabase db reset` がその場で落ちる。plpgsql では実行時まで気づけない。

CREATE OR REPLACE FUNCTION retention_expired_companies(p_cutoff TIMESTAMPTZ)
RETURNS TABLE (company_id UUID)
SECURITY DEFINER
SET search_path = public
LANGUAGE sql
STABLE AS $$
  SELECT DISTINCT e.company_id
    FROM public.events e
   WHERE e.ingested_at < p_cutoff
     AND e.company_id IS NOT NULL;
$$;

REVOKE EXECUTE ON FUNCTION retention_expired_companies(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION retention_expired_companies(TIMESTAMPTZ) TO service_role;
