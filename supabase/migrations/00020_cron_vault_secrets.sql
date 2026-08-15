-- 00020: sync-connections cron の秘密取得を GUC から Vault へ移行
--
-- 背景（2026-08-15 実測）:
--   00018 の cron 本文は current_setting('app.settings.supabase_url') /
--   current_setting('app.settings.service_role_key') を参照していた。
--   しかし本番でこのGUCを設定しようとすると PostgreSQL 15 以降のパラメータACLにより
--     ERROR: 42501: permission denied to set parameter "app.settings.supabase_url"
--   となり、Supabase の postgres ロールでは ALTER DATABASE ... SET が実行できない。
--   **経路そのものが塞がっている**ため、GUC方式は採用できない。
--
--   代替として、秘密の保管先を Vault に一本化する。Sentio の絶対規則
--   「秘密はVault以外のどこにも置かない」とも整合する。
--
-- 変更点:
--   1. 名前で引ける Vault ヘルパー read_vault_secret_by_name を追加する。
--      既存の read_vault_secret は UUID 引数のため、マイグレーション内に
--      シークレットのUUIDをハードコードする羽目になり運用に耐えない。
--      vault.secrets を直接参照するのは禁止（security definer 関数経由のみ）なので
--      ヘルパー自体を増やす。
--   2. cron.schedule を同名で呼び直し、ジョブ本文を Vault 参照に差し替える。
--      cron.schedule は同名ジョブを上書きするため再実行安全。
--
-- 冪等性: CREATE OR REPLACE / REVOKE / GRANT / cron.schedule 上書き のみ。再実行安全。

-- ---------------------------------------------------------------------------
-- 1. 名前引きの Vault ヘルパー
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION read_vault_secret_by_name(p_name TEXT)
RETURNS TEXT
SECURITY DEFINER
SET search_path = vault, public
LANGUAGE plpgsql AS $$
DECLARE
  v_secret TEXT;
  v_count  INT;
BEGIN
  SELECT count(*) INTO v_count FROM vault.decrypted_secrets WHERE name = p_name;

  -- 未登録を NULL で返すと、呼び出し側で
  -- `NULL || '/functions/v1/...'` = NULL となり net.http_post が
  -- 意味の読めないエラーで落ちる（"静かな失敗"に近い形になる）。
  -- 何が足りないのかがログに出るよう、ここで明示的に落とす。
  IF v_count = 0 THEN
    RAISE EXCEPTION 'vault secret not found: %', p_name;
  END IF;

  -- vault.secrets の name に一意制約があるかは Vault のバージョンに依存する。
  -- 同名が複数ある環境でどれか1件を黙って選ぶと、キーのローテーション時に
  -- 「古い値を使い続ける」が誰にも気づかれない形で起きる。曖昧なら落とす。
  IF v_count > 1 THEN
    RAISE EXCEPTION 'vault secret name is ambiguous (% rows): %', v_count, p_name;
  END IF;

  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = p_name;

  RETURN v_secret;
END;
$$;

-- SECURITY DEFINER は postgres 権限で走るため、anon/authenticated から呼べると
-- 間接的にVaultを読めてしまう。00017 と同じ方針で service_role に限定する。
REVOKE EXECUTE ON FUNCTION read_vault_secret_by_name(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION read_vault_secret_by_name(TEXT) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. cron ジョブの再登録（本文を Vault 参照へ）
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  -- ★ シークレット名の正本。
  --   人間側の登録手順書 docs/runbooks/2026-08-15_vault-secret-setup-procedure.md と
  --   prereq-check SQL の seq 6/7 は、この2つと完全一致していなければならない。
  c_secret_url CONSTANT TEXT := 'sentio_supabase_url';
  c_secret_key CONSTANT TEXT := 'sentio_service_role_key';

  v_command TEXT;
BEGIN
  -- cron 本文は pg_cron が保存した文字列をそのまま実行する。
  -- search_path に依存しないよう、関数はスキーマ修飾する。
  v_command := format($cmd$
    SELECT net.http_post(
      url := public.read_vault_secret_by_name(%L) || '/functions/v1/sync-connections',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || public.read_vault_secret_by_name(%L),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb
    );
  $cmd$, c_secret_url, c_secret_key);

  -- 同名ジョブは上書きされる（00018 が登録した GUC 版を置き換える）
  PERFORM cron.schedule('sync-connections', '0 0,6,12,18 * * *', v_command);
END;
$$;
