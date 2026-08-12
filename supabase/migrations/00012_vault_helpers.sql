-- 00012: Vault ヘルパー関数
-- SECURITY DEFINER でVaultアクセスを限定

CREATE OR REPLACE FUNCTION store_vault_secret(
  p_name TEXT, p_secret TEXT, p_description TEXT DEFAULT ''
) RETURNS UUID
SECURITY DEFINER
SET search_path = vault, public
LANGUAGE plpgsql AS $$
DECLARE
  v_id UUID;
BEGIN
  SELECT vault.create_secret(p_secret, p_name, p_description) INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION read_vault_secret(p_id UUID)
RETURNS TEXT
SECURITY DEFINER
SET search_path = vault, public
LANGUAGE plpgsql AS $$
DECLARE
  v_secret TEXT;
BEGIN
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE id = p_id;
  RETURN v_secret;
END;
$$;
