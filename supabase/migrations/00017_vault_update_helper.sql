-- 00017: Vault ヘルパー権限制限 + update関数追加
-- SECURITY DEFINER関数はservice_role以外から呼べないようにする

-- 新規: update_vault_secret
CREATE OR REPLACE FUNCTION update_vault_secret(p_id UUID, p_secret TEXT)
RETURNS VOID
SECURITY DEFINER
SET search_path = vault, public
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE vault.secrets
  SET secret = p_secret, updated_at = now()
  WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vault secret not found: %', p_id;
  END IF;
END;
$$;

-- 全Vaultヘルパーの実行権限をservice_roleに限定
-- Why: SECURITY DEFINERはpostgres権限で実行されるため、
--      anon/authenticatedから呼べると間接的にVaultを操作できてしまう
REVOKE EXECUTE ON FUNCTION store_vault_secret(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION store_vault_secret(TEXT, TEXT, TEXT) TO service_role;

REVOKE EXECUTE ON FUNCTION read_vault_secret(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION read_vault_secret(UUID) TO service_role;

REVOKE EXECUTE ON FUNCTION update_vault_secret(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION update_vault_secret(UUID, TEXT) TO service_role;
