-- 00051: CSV の摘要の正規化で、同じ Shift_JIS のバイトから来る文字（マイナス記号ほか5対）を寄せ、event_id を組み直す
--        （2026-09-13 の点検・PR-3 の 22b）
--
-- ## 何が起きたか
--
-- 2026-09-13、検収側が ab73e516… に8月分の CSV を /api/csv/ingest へ再送信したところ、
-- 40行は既存と同じ event_id で更新されたが、**19行は新規になった。**
--
-- 原因は文字コードの変換の違いである。Shift_JIS の 0x817C（－）を
--
--   - iconv の SHIFT_JIS は U+2212（MINUS SIGN）にする
--   - ブラウザの TextDecoder（CP932）は U+FF0D（FULLWIDTH HYPHEN-MINUS）にする
--
-- 00045 の `csv_normalize_description` は U+FF0D を全角→半角の translate で '-' に寄せるが、
-- **U+2212 は寄せていなかった。** 同じ明細が、読み方によって別の鍵になった
-- （19行は検収側が本番で削除し、59行に戻した）。
--
-- ## 何をするか
--
--   1. `csv_normalize_description` を CREATE OR REPLACE し、U+2212 → '-' を足す
--      加えて、同じバイトから来る5対（#135 の検収で決定）を寄せる:
--        0x8160 U+301C → '~' / 0x8161 U+2225 → U+2016 / 0x8191 U+FFE0 → U+00A2 /
--        0x8192 U+FFE1 → U+00A3 / 0x81CA U+FFE2 → U+00AC
--      本番の既存行にこれらの文字は0件（検収側が照会済み）
--      （TypeScript の `normalizeDescription` にも同じ1行を足した。**2つは同じ結果でなければならない**）
--   2. `source = 'csv:accounting'` の行の event_id を 00045 と同じ手順で組み直す
--      （同じ新 event_id に当たったら ingested_at が最も古い1行を残し、他を消す）
--
-- ## 本番で何行が変わるか（読み取り照会 2026-09-14 12:26:59Z）
--
--   ab73e516… の csv:accounting 59行: U+2212 を含む行 0 / U+FF0D を含む行 19 / U+002D を含む行 0
--   **新しい規則で event_id が変わる行: 0 件。重複として消える行: 0 件**
--
-- 本番の既存行はすべて U+FF0D（ブラウザ経由の取り込み）なので、組み直しは空振りする見込み。
-- それでも組み直しを入れるのは、**規則の変更と同時に既存行を新しい規則に揃える**ためである
-- （U+2212 の行がある環境では、その行が組み直る）。
--
-- ## 緩めすぎない
--
-- 寄せるのは U+2212 だけ。長音符（ー U+30FC）やダッシュ類（― U+2015 / — U+2014）は寄せない。
-- 長音符とハイフンを同じにすると、別の摘要が同じ鍵になりうる。
--
-- ## 冪等性
--
-- CREATE OR REPLACE と、00045 と同じ組み直し（2回目は `WHERE event_id <> 新` に当たらず0件）。再実行安全。

-- ---------------------------------------------------------------------------
-- 摘要の正規化（00045 の本体に 1-2 を足したもの）
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

  -- 1-2. **マイナス記号（U+2212）をハイフン（U+002D）に寄せる**（00051 で追加）。
  --      U+FF0D（全角ハイフン）は上の translate で既に '-' になる。
  --      見分けにくい文字をソースに直接書かないので chr(8722) で書く
  s := replace(s, chr(8722), '-');

  -- 1-3. **同じ Shift_JIS のバイトが、読み方で別の文字になる対を寄せる**（#135 の検収で決定）。
  --      同じバイトから来た文字どうしなので、寄せても別の取引が同じにはならない
  s := replace(s, chr(12316), '~');        -- 0x8160 波ダッシュ U+301C → '~'（U+FF5E は上の translate で '~'）
  s := replace(s, chr(8741), chr(8214));   -- 0x8161 双柱 U+2225 → U+2016
  s := replace(s, chr(65504), chr(162));   -- 0x8191 セント U+FFE0 → U+00A2
  s := replace(s, chr(65505), chr(163));   -- 0x8192 ポンド U+FFE1 → U+00A3
  s := replace(s, chr(65506), chr(172));   -- 0x81CA 否定 U+FFE2 → U+00AC

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
-- 組み直し（00045 と同じ手順）
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

  -- **同じ新 event_id に当たった行のうち、ingested_at が最も古い1行だけ残す**
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

  RAISE NOTICE '00051: CSV の event_id を組み直した（重複削除 %件 / 書き換え %件）',
    v_deleted, v_updated;
END $$;

-- ---------------------------------------------------------------------------
-- 自表検証。**期待と違えば migration を失敗させる**
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- U+2212（マイナス記号）と U+FF0D（全角ハイフン）と U+002D（ハイフン）が同じになること
  IF public.csv_normalize_description('A' || chr(8722) || 'B') <> public.csv_normalize_description('A' || chr(65293) || 'B')
     OR public.csv_normalize_description('A' || chr(8722) || 'B') <> 'A-B' THEN
    RAISE EXCEPTION '00051: マイナス記号・全角ハイフン・ハイフンが同じにならない（%）',
      public.csv_normalize_description('A' || chr(8722) || 'B');
  END IF;

  -- **緩めすぎていないこと**: 長音符はハイフンにしない。ハイフンを消さない
  IF public.csv_normalize_description('コ' || chr(12540) || 'ヒ') = public.csv_normalize_description('コ-ヒ') THEN
    RAISE EXCEPTION '00051: 長音符とハイフンが同一に潰れている';
  END IF;
  IF public.csv_normalize_description('A-B') = public.csv_normalize_description('AB') THEN
    RAISE EXCEPTION '00051: ハイフンが消えている';
  END IF;

  -- 同じ Shift_JIS のバイトから来る対 (a)〜(e) が同じになること（#135 の検収で決定）
  IF public.csv_normalize_description('A' || chr(12316) || 'B') <> public.csv_normalize_description('A' || chr(65374) || 'B')
     OR public.csv_normalize_description('A' || chr(12316) || 'B') <> 'A~B' THEN
    RAISE EXCEPTION '00051: 波ダッシュ（U+301C / U+FF5E）が同じにならない';
  END IF;
  IF public.csv_normalize_description('A' || chr(8741) || 'B') <> public.csv_normalize_description('A' || chr(8214) || 'B') THEN
    RAISE EXCEPTION '00051: 双柱（U+2225 / U+2016）が同じにならない';
  END IF;
  IF public.csv_normalize_description('1' || chr(65504)) <> public.csv_normalize_description('1' || chr(162)) THEN
    RAISE EXCEPTION '00051: セント（U+FFE0 / U+00A2）が同じにならない';
  END IF;
  IF public.csv_normalize_description('1' || chr(65505)) <> public.csv_normalize_description('1' || chr(163)) THEN
    RAISE EXCEPTION '00051: ポンド（U+FFE1 / U+00A3）が同じにならない';
  END IF;
  IF public.csv_normalize_description(chr(65506) || 'A') <> public.csv_normalize_description(chr(172) || 'A') THEN
    RAISE EXCEPTION '00051: 否定（U+FFE2 / U+00AC）が同じにならない';
  END IF;
  -- **波ダッシュを消していないこと**（'A~B' と 'AB' を同じにしない）
  IF public.csv_normalize_description('A~B') = public.csv_normalize_description('AB') THEN
    RAISE EXCEPTION '00051: 波ダッシュが消えている';
  END IF;

  -- 00045 の正規化が壊れていないこと
  IF public.csv_normalize_description('ﾃﾞﾝｷ ﾀﾞｲ') <> public.csv_normalize_description('デンキ　ダイ') THEN
    RAISE EXCEPTION '00051: 半角カナと全角カナが同じにならない';
  END IF;

  -- 同じ明細を U+2212 と U+FF0D で入れたとき、event_id が同じになること
  IF public.csv_event_id('00000000-0000-0000-0000-000000000000', '2026-08-01', 'debit', 1000,
                         'ｶ)ﾄﾘﾋｷ' || chr(8722) || 'ｻｷ', 5000)
     <> public.csv_event_id('00000000-0000-0000-0000-000000000000', '2026-08-01', 'debit', 1000,
                            'ｶ)ﾄﾘﾋｷ' || chr(65293) || 'ｻｷ', 5000) THEN
    RAISE EXCEPTION '00051: 同じ明細が U+2212 と U+FF0D で別の event_id になる';
  END IF;

  -- **CSV 由来の行に重複が残っていないこと**
  IF EXISTS (
    SELECT 1 FROM events WHERE source = 'csv:accounting'
    GROUP BY company_id, occurred_at, metrics->>'direction', metrics->>'amount',
             public.csv_normalize_description(coalesce(metrics->>'description', '')),
             metrics->>'balance'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '00051: 組み直したのに同じ内容の行が残っている';
  END IF;
END $$;
