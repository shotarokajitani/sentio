-- 00025: delete_vault_secret — 連携解除時にトークンを「直ちに破棄」するための関数
--
-- なぜ要るか:
--   プライバシーポリシー §6（src/app/privacy/page.tsx）で
--   「連携を解除した場合、アクセストークン・リフレッシュトークンを直ちに破棄します」
--   と公開した。**書いた以上、破棄する経路が実在しなければならない。**
--   現状 Vault 側の関数は store / update / read の3本だけで、削除の経路が無い。
--
--   connections 行を消すだけでは足りない。それは参照を失うだけで、
--   Vault には値が残り続ける。「破棄した」とは言えない。
--
-- なぜ DELETE を直接書いてよいか:
--   値の UPDATE は vault.update_secret() 経由でなければ
--   `permission denied for table secrets` になる（00022 で実測）。
--   一方 **DELETE は postgres ロールでそのまま通る**（2026-08-18 に
--   begin/rollback で囲んだプローブで実測。gotchas に記録済み）。
--   「UPDATE が拒否されるのだから DELETE も拒否されるはず」は成り立たない。
--   vault.delete_secret() に相当する API は提供されていないため、DELETE を使う。
--
-- 冪等性: 対象が無ければ false を返して正常終了する。例外にしない。
--   解除を2回押した・再試行された、で失敗させる理由が無い。
--   ただし「消えた（true）」と「元から無かった（false）」は呼び出し元に区別させる。
--
-- 権限: service_role のみ。anon / authenticated からは実行できない。
--   Vault は K2 の保管先であり、クライアントから触れる経路を作らない。

CREATE OR REPLACE FUNCTION delete_vault_secret(p_id UUID)
RETURNS BOOLEAN
SECURITY DEFINER
SET search_path = vault, public
LANGUAGE plpgsql AS $$
DECLARE
  deleted_count INT;
BEGIN
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'delete_vault_secret: p_id is null';
  END IF;

  DELETE FROM vault.secrets WHERE id = p_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  RETURN deleted_count > 0;
END;
$$;

REVOKE EXECUTE ON FUNCTION delete_vault_secret(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION delete_vault_secret(UUID) TO service_role;
