-- 00049: API のレート制限を記録する表（2026-09-13 の点検・PR-2a）
--
-- ## なぜ要るか
--
-- `src/app/api/**` にレート制限が1つも無かった（点検の実読）。
--
--   - `csv/analyze` と `competitors/suggest` は、認証済みなら**無制限に Anthropic を呼ぶ**
--   - `auth/session` の登録・ログインに関門が無い（総当たりもアカウントの量産もできる）
--   - `competitors/suggest` の「1回だけ」の判定は `entities` の有無で見ていたが、
--     `entities` は利用者が DELETE できる（00038）ので、消せば何度でも呼べた
--
-- **新しい外部サービスは使わない。** Postgres の表1つで数える。
--
-- ## 数え方
--
-- `(subject, route, window_start)` ごとに1行。**1文で数えて返す関数**
-- （`hit_rate_limit`）を通すので、同時に届いた要求で上限を超えない。
-- 読んでから書く形にすると、2つの要求が同じ件数を読んで両方通る。
--
-- `subject` は `company:<uuid>` か `ip:<addr>` の文字列にする。**会社単位と IP 単位を
-- 1つの列で持つ。** 列を分けると一意索引が NULL を含み、
-- 00043 の部分索引と同じ推論の問題を踏む。
--
-- ## 権限
--
-- **service_role だけ。** `authenticated` が書けると、利用者が自分の件数を0に戻せる。
-- RLS は有効にしてポリシーを置かない（= service_role 以外は何もできない）。
--
-- ## 冪等性
--
-- CREATE TABLE / INDEX / FUNCTION IF NOT EXISTS・OR REPLACE のみ。再実行安全。

CREATE TABLE IF NOT EXISTS public.api_rate_limits (
  subject      TEXT        NOT NULL,
  route        TEXT        NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count        INT         NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (subject, route, window_start)
);

ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;

-- **利用者にもログイン前の人にも、何も渡さない**
REVOKE ALL ON public.api_rate_limits FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_rate_limits TO service_role;

-- 古い窓を掃除するときに使う
CREATE INDEX IF NOT EXISTS idx_api_rate_limits_window ON public.api_rate_limits (window_start);

-- ---------------------------------------------------------------------------
-- 1文で数えて、数えた後の件数を返す
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hit_rate_limit(
  p_subject TEXT,
  p_route TEXT,
  p_window_start TIMESTAMPTZ
)
RETURNS INT
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
  INSERT INTO public.api_rate_limits AS r (subject, route, window_start, count, updated_at)
  VALUES (p_subject, p_route, p_window_start, 1, now())
  ON CONFLICT (subject, route, window_start)
  DO UPDATE SET count = r.count + 1, updated_at = now()
  RETURNING r.count;
$$;

REVOKE ALL ON FUNCTION public.hit_rate_limit(TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hit_rate_limit(TEXT, TEXT, TIMESTAMPTZ) TO service_role;

-- ---------------------------------------------------------------------------
-- 自表検証。**期待と違えば migration を失敗させる**
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_first INT;
  v_second INT;
  v_window TIMESTAMPTZ := date_trunc('day', now());
BEGIN
  -- 利用者は表を読めも書けもしない
  IF has_table_privilege('authenticated', 'public.api_rate_limits', 'SELECT')
     OR has_table_privilege('authenticated', 'public.api_rate_limits', 'INSERT')
     OR has_table_privilege('authenticated', 'public.api_rate_limits', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.api_rate_limits', 'DELETE') THEN
    RAISE EXCEPTION '00049: authenticated が api_rate_limits に権限を持っている';
  END IF;
  IF has_function_privilege('authenticated', 'public.hit_rate_limit(text, text, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION '00049: authenticated が hit_rate_limit を呼べる（件数を増やせる）';
  END IF;

  -- **1回目は1、2回目は2を返す**（数えて返す1文になっていること）
  v_first := public.hit_rate_limit('migration:self-check', 'self-check', v_window);
  v_second := public.hit_rate_limit('migration:self-check', 'self-check', v_window);
  IF v_first <> 1 OR v_second <> 2 THEN
    RAISE EXCEPTION '00049: hit_rate_limit が % → % を返した（1 → 2 のはず）', v_first, v_second;
  END IF;

  DELETE FROM public.api_rate_limits WHERE subject = 'migration:self-check';
END $$;
