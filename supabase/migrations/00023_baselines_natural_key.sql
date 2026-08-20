-- 00023: baselines に自然キーの一意索引を張る（契約 S-方針1 / S-D2 / S-1-1）
--
-- `state-baselines` は upsert で baseline を書くが、`00003` には
-- `(company_id, metric_key, ...)` に対応する一意制約が無い（`idx_baselines_company` は非UNIQUE）。
-- そのため `ON CONFLICT` が
--   42P10 there is no unique or exclusion constraint matching the ON CONFLICT specification
-- で必ず失敗していた（P-1 の3重不成立のうちの1つ）。
--
-- 自然キーは `spec/02`「指標×エンティティ(任意)×粒度ごと」に従い **4列**:
--   (company_id, metric_key, entity_id, granularity)
--
-- **`entity_id` を落としてはいけない。** 3列にすると、同じ `metric_key` を持つ
-- 別エンティティの baseline が同一キーに衝突して上書きし合う。これは修復ではなくデータ破壊。
--
-- `entity_id` は NULL を取りうる（会社全体の指標）。PostgreSQL の UNIQUE は既定で
-- NULL を互いに異なる値として扱う（NULLS DISTINCT）ため、そのままでは
-- 「会社全体の revenue」の行が何行でも作れてしまい、一意索引の意味が無い。
-- したがって **NULLS NOT DISTINCT**（PostgreSQL 15 以降）を使う。
--
-- 冪等性: 重複の事前検査 → CREATE UNIQUE INDEX IF NOT EXISTS。再実行安全。

-- ---------------------------------------------------------------------------
-- 1. サーバのバージョンを確かめる
--
-- `NULLS NOT DISTINCT` は PostgreSQL 15 で入った構文で、14 以下では**構文エラー**になる。
-- 素の CREATE INDEX 文で書くと、パース時点で落ちるためメッセージが読めない。
-- 動的SQLにしてパースを実行時まで遅らせ、**何が起きたのかが分かる形で**止める。
--
-- `supabase/config.toml` の `major_version = 15` はローカルスタックの宣言であって、
-- 本番の実測ではない（同ファイルのコメント自身が remote で確認せよと書いている）。
-- ここで実物を見る。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_num INT := current_setting('server_version_num')::INT;
  dup_count INT;
BEGIN
  RAISE NOTICE '00023: server_version = %', current_setting('server_version');

  IF v_num < 150000 THEN
    RAISE EXCEPTION
      '00023: PostgreSQL 15 以降が要る（実測 %）。NULLS NOT DISTINCT が使えないため、'
      '自然キーの一意索引を張れない。部分索引や式索引への差し替えは PostgREST の '
      'on_conflict が列名しか受け取れないため upsert 経路では成立しない。'
      '設計の見直しが要るので、この migration を書き換える前に契約書の S-D2 を再検討すること。',
      current_setting('server_version');
  END IF;

  -- ---------------------------------------------------------------------------
  -- 2. 既存の重複を先に見る
  --
  -- 一意索引の作成は重複行があると失敗する。失敗メッセージだけでは
  -- 「どのキーが重複しているか」が分からないので、先に数えて中身を出す。
  -- 黙って重複を消す方は採らない（どちらの行が正しいかは機械には決められない）。
  -- ---------------------------------------------------------------------------
  SELECT count(*) INTO dup_count FROM (
    SELECT company_id, metric_key, entity_id, granularity
      FROM baselines
     GROUP BY company_id, metric_key, entity_id, granularity
    HAVING count(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      '00023: baselines に自然キーの重複が %件ある。'
      'select company_id, metric_key, entity_id, granularity, count(*) from baselines '
      'group by 1,2,3,4 having count(*) > 1; で中身を確認し、'
      'どの行を残すか決めてから再実行すること（機械で消さない）', dup_count;
  END IF;

  -- ---------------------------------------------------------------------------
  -- 3. 一意索引
  --
  -- 動的SQLにしているのは 1 の理由（14 以下でのパースエラーを避ける）による。
  -- ---------------------------------------------------------------------------
  EXECUTE $ddl$
    CREATE UNIQUE INDEX IF NOT EXISTS idx_baselines_natural_key
      ON baselines (company_id, metric_key, entity_id, granularity)
      NULLS NOT DISTINCT
  $ddl$;

  RAISE NOTICE '00023: idx_baselines_natural_key を作成した（または既存）';
END $$;

-- ---------------------------------------------------------------------------
-- 4. RLS の再アサート
--
-- 新テーブルではないので `00013` のリスト追記は不要だが、
-- 「索引を足したのに RLS を見ていない」を作らないためにここで1回確かめる
-- （`00024` と同じ作法）。
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'baselines' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION '00023: RLS not enabled on table: baselines';
  END IF;

  -- 00019 が張った操作別ポリシー4本が居ること（company_id = auth.uid()）
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'baselines') < 4 THEN
    RAISE EXCEPTION '00023: baselines のRLSポリシーが4本未満（00019 の適用漏れを疑う）';
  END IF;
END $$;
