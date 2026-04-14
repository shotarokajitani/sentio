import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { initSentry, captureError } from "../_shared/sentry.ts";
import { getUserClient, corsHeaders } from "../_shared/supabase.ts";

initSentry("update-company-settings");

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // JWT必須
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "認証が必要です" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const userClient = getUserClient(authHeader);
  const {
    data: { user },
    error: authError,
  } = await userClient.auth.getUser();
  if (authError || !user) {
    return new Response(JSON.stringify({ error: "認証が必要です" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = (await req.json()) as {
      company_name?: string;
      url?: string;
      initial_concern?: string | null;
      industry?: string | null;
    };

    const companyName = (body.company_name ?? "").trim();
    const url = (body.url ?? "").trim();
    if (!companyName || !url) {
      return new Response(
        JSON.stringify({ error: "company_name と url は必須です" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // user_idはauth.uid()から取得（フロントからは受け取らない）
    // RLS下でUPDATE: user_id = auth.uid() に絞られる
    const { data, error } = await userClient
      .from("companies")
      .update({
        company_name: companyName,
        url,
        industry: body.industry?.trim() || null,
        initial_concern: body.initial_concern?.trim() || null,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", user.id)
      .select()
      .single();

    if (error || !data) {
      throw error ?? new Error("update failed");
    }

    return new Response(JSON.stringify({ success: true, company: data }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    captureError(error as Error, { extra: { user_id: user.id } });
    return new Response(JSON.stringify({ error: "設定の保存に失敗しました" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
