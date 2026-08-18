import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface Tenant {
  /** company_id と同値。RLSポリシーが company_id = auth.uid() のため */
  id: string;
  email: string;
  password: string;
  /** サインイン済み（anon key ＋ ユーザーセッション）＝RLSが効くクライアント */
  client: SupabaseClient;
}

/**
 * テナント用ユーザーを作り、サインイン済みクライアントを返す。
 *
 * 越境検証は「2社を実際に作って実クエリを投げる」以外の方法では固定できない。
 * モックしたクライアントではRLSそのものを検証したことにならない。
 */
export async function makeTenant(args: {
  admin: SupabaseClient;
  supabaseUrl: string;
  anonKey: string;
  runId: string;
  label: string;
}): Promise<Tenant> {
  const email = `${args.runId}-${args.label}@example.test`;
  const password = `Ten!${args.runId}${args.label}9x`;

  const { data, error } = await args.admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser(${args.label}) 失敗: ${error?.message}`);

  const client = createClient(args.supabaseUrl, args.anonKey, { auth: { persistSession: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signIn(${args.label}) 失敗: ${signInError.message}`);

  return { id: data.user.id, email, password, client };
}
