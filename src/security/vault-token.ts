import type { SupabaseClient } from "@supabase/supabase-js";

export const GOOGLE_CALENDAR_PROVIDER = "google_calendar";

/**
 * 新規作成するVaultシークレットの名前。
 *
 * vault.secrets.name には一意制約（secrets_name_idx）が**実在する**
 * （2026-08-18 のCIで duplicate key 違反として実測）。
 * そのため固定名にすると、接続行が失われた状態からの再作成が必ず衝突する。
 *
 * name はもう検索キーではない（正本は connections.vault_secret_id）ので、
 * 人間が読める識別子＋一意サフィックスで足りる。
 */
export function vaultSecretName(companyId: string): string {
  return `${GOOGLE_CALENDAR_PROVIDER}:${companyId}:${crypto.randomUUID()}`;
}

export type UpsertVaultTokenResult = {
  vaultId: string | null;
  /** 新規作成なら "created"、既存更新なら "updated"（呼び出し側のログ用） */
  action: "created" | "updated" | null;
  error: string | null;
};

/**
 * OAuthトークンをVaultへ保存し、その secret id を返す。
 *
 * 既存接続があれば update_vault_secret、無ければ store_vault_secret を使う。
 *
 * Why: 旧実装は毎回 store_vault_secret を呼んでいた。再連携すると
 * `google_calendar:<company_id>` という同名シークレットが増える。
 * vault.secrets.name に一意制約があれば2回目の連携が失敗し、
 * 無ければ重複が溜まって read_vault_secret_by_name（00020）が
 * 曖昧エラーになる。**どちらに転んでも再連携で壊れる。**
 *
 * 本実装は vault.secrets を name で一切引かない。正本は
 * connections.vault_secret_id（(company_id, provider) は00016で一意）なので、
 * name の一意制約の有無に挙動が依存しない。
 *
 * 接続行だけが失われ、シークレットが孤児として残った場合も新規作成側で回復する
 * （名前を一意にしてあるため衝突しない）。孤児シークレットはVaultに残るが、
 * 参照されないだけで実害はない。
 */
export async function upsertVaultToken(
  supabase: SupabaseClient,
  companyId: string,
  tokenPayload: string,
): Promise<UpsertVaultTokenResult> {
  const { data: existing, error: selErr } = await supabase
    .from("connections")
    .select("vault_secret_id")
    .eq("company_id", companyId)
    .eq("provider", GOOGLE_CALENDAR_PROVIDER)
    .maybeSingle();

  if (selErr) {
    return { vaultId: null, action: null, error: `connection lookup failed: ${selErr.message}` };
  }

  const existingId: string | null = existing?.vault_secret_id ?? null;

  if (existingId) {
    const { error: updErr } = await supabase.rpc("update_vault_secret", {
      p_id: existingId,
      p_secret: tokenPayload,
    });
    if (!updErr) {
      return { vaultId: existingId, action: "updated", error: null };
    }
    // 参照先のシークレットが消えている場合のみここに来る。新規作成へフォールバックする
    console.warn(`update_vault_secret failed, falling back to create: ${updErr.message}`);
  }

  const { data: newId, error: storeErr } = await supabase.rpc("store_vault_secret", {
    p_name: vaultSecretName(companyId),
    p_secret: tokenPayload,
    p_description: "Google Calendar OAuth token",
  });

  if (storeErr) {
    return { vaultId: null, action: null, error: `store_vault_secret failed: ${storeErr.message}` };
  }

  return { vaultId: newId as string, action: "created", error: null };
}
