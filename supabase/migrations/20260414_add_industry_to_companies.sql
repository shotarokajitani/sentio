-- companiesテーブルに industry カラムを追加
-- register-company Edge Function が industry を INSERT するが、
-- カラムが存在せず500エラーになっていたため追加する。

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS industry text;

-- PostgRESTのスキーマキャッシュをリロード
NOTIFY pgrst, 'reload schema';
