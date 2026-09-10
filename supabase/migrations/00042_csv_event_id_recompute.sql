-- 00042: CSV 由来の events を新しい event_id 規則で1度だけ組み直す（発注 ①-5）
--
-- ## なぜ要るか
--
-- 旧規則は `sha256("csv:" || company_id || ':' || file_name || ':' || 行の生テキスト)`
-- で、**ファイル名が鍵に入っていた。** 同じ明細を別名で取り込むと全行が二重に入る。
-- 列の並びを変えただけの再出力でも `cols.join(",")` が変わるので二重になる。
--
-- **顧客は「入れ直した」だけのつもりで、入出金も残高も倍になっていた。**
--
-- 新規則（`src/lib/csv/event-id.ts` と**同じ組み立て**）:
--
--   sha256('csv:' || company_id || ':' || 日付 || ':' || direction || ':' || amount
--          || ':' || 正規化した摘要 || ':' || 残高)
--
-- ## 何をするか
--
--   1. `source = 'csv:accounting'` の行について新しい `event_id` を計算する
--   2. 同じ新 `event_id` に複数行が当たったら、**`ingested_at` が最も古い1行を残す**
--   3. 残した行の `event_id` を新しい値に書き換える
--
-- 古い行を残すのは、**最初に取り込んだ事実を残すため**である。新しいほうを残すと
-- 「いつ入ってきたデータか」が入れ直しのたびに動く。
--
-- **`events` に `created_at` は無い**（2026-09-10 の本番実測。列は event_id /
-- company_id / occurred_at / period_start / period_end / ingested_at / source /
-- event_type / actor_ref / entity_refs / metrics / sensitivity の12本）。
-- 取り込んだ時刻は `ingested_at` である。CI で `column e.created_at does not exist
-- (SQLSTATE 42703)` として実測した。
--
-- ## 正規化を SQL 側にも書く
--
-- **TypeScript の `normalizeDescription` と同じ結果でなければならない。**
-- 順序も同じにしてある（全角英数→半角 / 半角カナ→全角 / 空白除去 / 大文字化）。
-- ずれると、この migration のあとに取り込んだ行が過去の行と重ならない。
-- 一致は `tests/integration/csv-dedupe.test.ts` が実DBで確かめる。
--
-- ## 冪等性
--
-- 2回目は「新 event_id が既に入っている」ので `WHERE event_id <> 新` に当たらず、
-- 0件更新で終わる。再実行安全。

-- ---------------------------------------------------------------------------
-- 摘要の正規化。TypeScript 側と同じ順序で行う
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.csv_normalize_description(raw TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  s TEXT := coalesce(raw, '');
BEGIN
  -- 1. 全角の英数記号を半角へ（U+FF01〜U+FF5E → ASCII 0x21〜0x7E）
  s := translate(
    s,
    '！＂＃＄％＆＇（）＊＋，－．／０１２３４５６７８９：；＜＝＞？＠' ||
    'ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ［＼］＾＿｀' ||
    'ａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ｛｜｝～',
    '!"#$%&''()*+,-./0123456789:;<=>?@' ||
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ[\]^_`' ||
    'abcdefghijklmnopqrstuvwxyz{|}~'
  );
  s := replace(s, '　', ' ');

  -- 2. 半角カナを全角へ。**濁点・半濁点の合成を先に行う**
  --    （2文字を1文字にしてから、残りの単体を置き換える）
  s := replace(replace(replace(replace(replace(s,
        'ｶﾞ','ガ'),'ｷﾞ','ギ'),'ｸﾞ','グ'),'ｹﾞ','ゲ'),'ｺﾞ','ゴ');
  s := replace(replace(replace(replace(replace(s,
        'ｻﾞ','ザ'),'ｼﾞ','ジ'),'ｽﾞ','ズ'),'ｾﾞ','ゼ'),'ｿﾞ','ゾ');
  s := replace(replace(replace(replace(replace(s,
        'ﾀﾞ','ダ'),'ﾁﾞ','ヂ'),'ﾂﾞ','ヅ'),'ﾃﾞ','デ'),'ﾄﾞ','ド');
  s := replace(replace(replace(replace(replace(s,
        'ﾊﾞ','バ'),'ﾋﾞ','ビ'),'ﾌﾞ','ブ'),'ﾍﾞ','ベ'),'ﾎﾞ','ボ');
  s := replace(replace(replace(replace(replace(s,
        'ﾊﾟ','パ'),'ﾋﾟ','ピ'),'ﾌﾟ','プ'),'ﾍﾟ','ペ'),'ﾎﾟ','ポ');
  s := replace(s, 'ｳﾞ', 'ヴ');
  s := translate(
    s,
    'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝｧｨｩｪｫｬｭｮｯｰ｢｣､｡･',
    'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンァィゥェォャュョッー「」、。・'
  );

  -- 3. 空白をすべて除去 → 4. 大文字化
  s := regexp_replace(s, '\s+', '', 'g');
  RETURN upper(s);
END;
$$;

-- ---------------------------------------------------------------------------
-- 数値の文字列化。**JS の `String(n)` と同じ結果にする**
--
-- `to_char(396000, 'FM999999999999990.999999')` は `396000.` を返す。
-- **`FM` は末尾のゼロを削るが、ピリオドは残る**（2026-09-10 の本番実測）。
-- そのまま鍵に入れると TypeScript 側の `"396000"` と一致しない——
-- CI の統合試験が実際にこのずれを捕まえた。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.csv_number_text(v NUMERIC)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT rtrim(rtrim(trim(to_char(v, 'FM999999999999990.999999')), '0'), '.');
$$;

-- ---------------------------------------------------------------------------
-- 新しい event_id。**TypeScript の `csvEventId` と同じ並び**
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.csv_event_id(
  p_company UUID,
  p_date TEXT,
  p_direction TEXT,
  p_amount NUMERIC,
  p_description TEXT,
  p_balance NUMERIC
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(
    -- **`digest` は extensions スキーマにある**（2026-09-10 の本番実測）。
    -- 修飾しないと search_path 次第で見つからない
    extensions.digest(
      'csv:' || p_company::text || ':' || p_date || ':' || p_direction || ':' ||
      -- **整数は小数点を付けない。** JS の String(396000) は "396000" である
      public.csv_number_text(p_amount) || ':' ||
      public.csv_normalize_description(p_description) || ':' ||
      CASE WHEN p_balance IS NULL THEN ''
           ELSE public.csv_number_text(p_balance) END,
      'sha256'
    ),
    'hex'
  );
$$;

-- ---------------------------------------------------------------------------
-- 組み直し。**古い1行を残して、他を消す**
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_deleted INT;
  v_updated INT;
BEGIN
  CREATE TEMP TABLE csv_recompute ON COMMIT DROP AS
  SELECT
    e.event_id AS old_id,
    e.ingested_at,
    public.csv_event_id(
      e.company_id,
      to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
      coalesce(e.metrics->>'direction', 'unknown'),
      abs(coalesce((e.metrics->>'amount')::numeric, 0)),
      coalesce(e.metrics->>'description', '(不明)'),
      CASE WHEN e.metrics ? 'balance' THEN (e.metrics->>'balance')::numeric ELSE NULL END
    ) AS new_id
  FROM events e
  WHERE e.source = 'csv:accounting';

  -- **同じ新 event_id に当たった行のうち、created_at が最も古い1行だけ残す**
  WITH ranked AS (
    SELECT old_id, new_id,
           row_number() OVER (PARTITION BY new_id ORDER BY ingested_at ASC NULLS LAST, old_id ASC) AS rn
    FROM csv_recompute
  )
  DELETE FROM events
  WHERE event_id IN (SELECT old_id FROM ranked WHERE rn > 1);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  UPDATE events e
  SET event_id = r.new_id
  FROM csv_recompute r
  WHERE e.event_id = r.old_id AND e.event_id <> r.new_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RAISE NOTICE '00042: CSV の event_id を組み直した（重複削除 %件 / 書き換え %件）',
    v_deleted, v_updated;
END $$;

-- ---------------------------------------------------------------------------
-- 自表検証。**期待と違えば migration を失敗させる**
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- 摘要の正規化が、全角・半角・空白の違いを吸収すること
  IF public.csv_normalize_description('ﾃﾞﾝｷ ﾀﾞｲ') <> public.csv_normalize_description('デンキ　ダイ') THEN
    RAISE EXCEPTION '00042: 半角カナと全角カナが同じにならない';
  END IF;
  IF public.csv_normalize_description('ａｂｃ') <> 'ABC' THEN
    RAISE EXCEPTION '00042: 全角英字が半角・大文字にならない';
  END IF;

  -- **別の取引まで同じにしていないこと**（緩めすぎの検出）
  IF public.csv_normalize_description('A社') = public.csv_normalize_description('B社') THEN
    RAISE EXCEPTION '00042: 別の摘要が同一に潰れている';
  END IF;

  -- **数値の文字列化が JS と同じ形になること。** ここがずれると全行の鍵がずれる
  IF public.csv_number_text(396000) <> '396000' THEN
    RAISE EXCEPTION '00042: 整数に余計な文字が付く（%）', public.csv_number_text(396000);
  END IF;
  IF public.csv_number_text(0) <> '0' THEN
    RAISE EXCEPTION '00042: 0 が % になる', public.csv_number_text(0);
  END IF;
  IF public.csv_number_text(396000.5) <> '396000.5' THEN
    RAISE EXCEPTION '00042: 小数が % になる', public.csv_number_text(396000.5);
  END IF;

  -- 残高の有無で鍵が変わること（無い形式を "null" と書いていない）
  IF public.csv_event_id('00000000-0000-0000-0000-000000000000', '2026-09-01', 'credit',
                          396000, 'テスト', NULL)
     = public.csv_event_id('00000000-0000-0000-0000-000000000000', '2026-09-01', 'credit',
                            396000, 'テスト', 100) THEN
    RAISE EXCEPTION '00042: 残高の有無で event_id が変わらない';
  END IF;

  -- **CSV 由来の行に重複が残っていないこと**
  IF EXISTS (
    SELECT 1 FROM events WHERE source = 'csv:accounting'
    GROUP BY company_id, occurred_at, metrics->>'direction', metrics->>'amount',
             public.csv_normalize_description(coalesce(metrics->>'description', '')),
             metrics->>'balance'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '00042: 組み直したのに同じ内容の行が残っている';
  END IF;
END $$;
