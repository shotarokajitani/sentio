import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { initSentry, captureError } from "../_shared/sentry.ts";
import {
  getServiceClient,
  getUserClient,
  corsHeaders,
} from "../_shared/supabase.ts";

initSentry("register-company");

// Trial期間（日数）— サーバー側で固定
const TRIAL_DAYS = 14;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // この関数は `--no-verify-jwt` でデプロイされているため、
  // Supabaseゲートウェイでの自動JWT検証は行われない。
  // Authorizationヘッダーから取り出したJWTを supabase.auth.getUser(jwt) で手動検証する。
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "認証が必要です" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) {
    return new Response(JSON.stringify({ error: "JWTが不正です" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const userClient = getUserClient(authHeader);
  const {
    data: { user },
    error: authError,
  } = await userClient.auth.getUser(jwt);
  if (authError || !user) {
    console.error("register-company auth failed:", authError);
    return new Response(
      JSON.stringify({
        error: "認証が必要です",
        detail: authError?.message,
      }),
      {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  try {
    // フロントから受け取るのは company_name, url, industry, initial_concern のみ
    // plan / status / trial_ends_at は一切受け取らない
    const body = (await req.json()) as {
      company_name?: string;
      url?: string;
      industry?: string | null;
      initial_concern?: string | null;
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

    // RLSをバイパスせず、ユーザー文脈で書き込む（user_id詐称を防ぐ）
    const supabase = userClient;

    const { data: company, error: companyError } = await supabase
      .from("companies")
      .insert({
        user_id: user.id,
        company_name: companyName,
        url,
        industry: body.industry?.trim() || null,
        initial_concern: body.initial_concern?.trim() || null,
        onboarding_stage: "stage1",
      })
      .select()
      .single();

    if (companyError || !company) {
      throw companyError ?? new Error("companies insert failed");
    }

    // subscriptions はサーバー側固定値で作成
    // plan='trial', status='trialing', trial_ends_at = now + 14日
    // RLSでsubscriptionsへのINSERTを許可していない可能性があるためservice roleで実行
    const service = getServiceClient();
    const trialEndsAt = new Date(
      Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { error: subError } = await service.from("subscriptions").insert({
      company_id: company.id,
      plan: "trial",
      status: "trialing",
      trial_ends_at: trialEndsAt,
      current_period_end: trialEndsAt,
    });

    if (subError) {
      // companiesをロールバック
      await service.from("companies").delete().eq("id", company.id);
      throw subError;
    }

    return new Response(JSON.stringify({ success: true, company }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    captureError(error as Error, { extra: { user_id: user.id } });
    return new Response(JSON.stringify({ error: "会社登録に失敗しました" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
