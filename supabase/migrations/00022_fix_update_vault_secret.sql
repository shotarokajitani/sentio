-- 00022: update_vault_secret を vault.update_secret 経由に修正
--
-- 症状（2026-08-18 CIで実測）:
--   update_vault_secret を実際に呼ぶと `permission denied for table secrets` で失敗する。
--   00017 の実装は `UPDATE vault.secrets SET secret = ...` と直接テーブルを書いていたが、
--   現行の Supabase Vault では vault.secrets への直接UPDATEが拒否される
--   （SECURITY DEFINER でも不可）。値の更新は vault.update_secret() を使う必要がある。
--
-- 影響範囲（重要）:
--   supabase/functions/_shared/token-refresh.ts がこの関数でリフレッシュ後のトークンを
--   保存している。つまり **00017 適用以降、トークンリフレッシュは保存に失敗し続けていた**。
--   マイグレーション適用も関数作成も成功するため、実際に呼ぶまで発覚しなかった。
--
-- なぜ事前確認をすり抜けたか:
--   前提確認SQL（2026-08-15_token-refresh-prereq-check.sql）は
--   has_function_privilege によるカタログ参照で「関数が在る・service_roleが実行できる」
--   ことだけを見ていた。**存在と実行可能性は、正しく動くことを意味しない。**
--   統合テスト側も update_vault_secret をモックしていたため実関数を一度も呼んでいなかった。
--   tests/integration/vault-token-rotation.test.ts が実DBに対して実際に呼ぶことで顕在化した。
--
-- 冪等性: CREATE OR REPLACE。再実行安全。権限は CREATE OR REPLACE で維持されるが、
--         意図を明示するため REVOKE/GRANT を再掲する。

CREATE OR REPLACE FUNCTION update_vault_secret(p_id UUID, p_secret TEXT)
RETURNS VOID
SECURITY DEFINER
SET search_path = vault, public
LANGUAGE plpgsql AS $$
BEGIN
  -- 不在を「更新できた」と誤認しないよう、先に存在を確認する。
  -- decrypted_secrets は read_vault_secret でも使っている読み取り経路。
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE id = p_id) THEN
    RAISE EXCEPTION 'vault secret not found: %', p_id;
  END IF;

  -- vault.secrets を直接書かない。暗号化は Vault 側の責務。
  PERFORM vault.update_secret(p_id, p_secret);
END;
$$;

REVOKE EXECUTE ON FUNCTION update_vault_secret(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION update_vault_secret(UUID, TEXT) TO service_role;
