/**
 * ディスパッチャの実行時配線（契約 スライスCD）。
 *
 * 判断は `_shared/dispatch.ts` の純ロジックに閉じてある。ここは
 * **Supabase と fetch を繋ぐだけ**である。`dispatch-daily` と `dispatch-weekly` で
 * 同じ配線を2回書くと、片方だけ直したときに宛先の取り方が割れる。
 */

import { getSupabaseAdmin } from "./supabase-client.ts";
import { mustData } from "./db.ts";
import type { CompanyTarget, DispatchDeps, InvokeResult } from "./dispatch.ts";

/**
 * 宛先の正本は `auth.users.email`（CD-D1）。**新しいテーブルを作らない。**
 *
 * RLS ポリシー（`00019`）が `company_id = auth.uid()` なので、
 * 会社とアカウントは 1:1 である（`src/lib/auth/company.ts` と同じ前提）。
 * したがって `auth.users.id` がそのまま `company_id` になる。
 */
export function buildDeps(): DispatchDeps {
  const supabase = getSupabaseAdmin();
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  return {
    listTargets: async (): Promise<CompanyTarget[]> => {
      // service_role でのみ引ける。ページングの上限は当面の会社数から余裕を見た固定値
      const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
      if (error) throw new Error(`dispatch: auth ユーザー一覧の取得に失敗: ${error.message}`);

      // 連携の有無は provider ごとではなく会社ごとに畳む（CD-D3）
      const connections = await mustData(
        supabase.from("connections").select("company_id, status"),
        "dispatch: connections",
      );
      const connected = new Set(
        connections.filter((c) => c.status === "active").map((c) => c.company_id as string),
      );

      return (data?.users ?? []).map((user) => ({
        companyId: user.id,
        email: user.email ?? null,
        hasConnection: connected.has(user.id),
      }));
    },

    invoke: async (fn: string, body: Record<string, unknown>): Promise<InvokeResult> => {
      // `run-sense` が `scan` を呼ぶのと同じ作法（service_role で internal 経路に入る）
      const res = await fetch(`${supabaseUrl}/functions/v1/${fn}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        body: JSON.stringify(body),
      });

      // **本文は読まない。** 失敗時の本文には会社の活動データが乗りうる（S-3-5 と同じ理由）
      return { ok: res.ok, status: res.status };
    },
  };
}
