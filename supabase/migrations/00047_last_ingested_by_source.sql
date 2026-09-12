-- 00047: 会社×データ源ごとの最後の取り込み時刻を引く関数（PS-9c の改訂）
--
-- ## なぜ要るか
--
-- 配信の対象を**会社単位から源ごとに**変えた。源ごとに「生きているか」を
-- 決めるには、最後に取り込めた時刻が要る。
--
-- **PostgREST では集計できない。** `events` を全件引いて手元で数えると、
-- 会社が増えるほど1回の配信で読む行数が膨らむ。`GROUP BY` をDB側で済ませる。
--
-- ## 権限
--
-- **`service_role` だけに渡す。** 全社の取り込み時刻が1回で見えるので、
-- `authenticated` に渡すと他社の活動の有無が読める。
-- `SECURITY INVOKER` にして、RLS を素通しする経路を作らない。
--
-- ## 冪等性
--
-- CREATE OR REPLACE FUNCTION / REVOKE / GRANT のみ。再実行安全。

CREATE OR REPLACE FUNCTION public.last_ingested_by_source()
RETURNS TABLE (company_id UUID, source TEXT, last_ingested_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT e.company_id, e.source, max(e.ingested_at)
  FROM events e
  GROUP BY e.company_id, e.source;
$$;

REVOKE ALL ON FUNCTION public.last_ingested_by_source() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.last_ingested_by_source() TO service_role;

-- ---------------------------------------------------------------------------
-- 自表検証。**期待と違えば migration を失敗させる**
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- **authenticated が呼べないこと。** 全社の取り込みの有無が読めてしまう
  IF has_function_privilege('authenticated', 'public.last_ingested_by_source()', 'EXECUTE') THEN
    RAISE EXCEPTION '00047: authenticated が last_ingested_by_source を呼べる';
  END IF;
  IF has_function_privilege('anon', 'public.last_ingested_by_source()', 'EXECUTE') THEN
    RAISE EXCEPTION '00047: anon が last_ingested_by_source を呼べる';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.last_ingested_by_source()', 'EXECUTE') THEN
    RAISE EXCEPTION '00047: service_role が last_ingested_by_source を呼べない';
  END IF;
END $$;
