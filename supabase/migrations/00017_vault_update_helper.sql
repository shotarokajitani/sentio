-- 00017: Vault secret 更新ヘルパー
-- トークンリフレッシュ時にVault内の秘密を上書きする

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
