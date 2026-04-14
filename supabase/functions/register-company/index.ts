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

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // この関数は `--no-verify-jwt` でデプロイされているため、
  // Supabaseゲートウェイでの自動JWT検証は行われない。関数内で手動検証する。
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResp({ error: "認証が必要です" }, 401);

  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return jsonResp({ error: "JWTが不正です" }, 401);

  const userClient = getUserClient(authHeader);
  const {
    data: { user },
    error: authError,
  } = await userClient.auth.getUser(jwt);
  if (authError || !user) {
    console.error("[register-company] auth failed:", authError);
    return jsonResp(
      { error: "認証が必要です", detail: authError?.message },
      401,
    );
  }

  try {
    const body = (await req.json()) as {
      company_name?: string;
      url?: string;
      industry?: string | null;
      initial_concern?: string | null;
    };

    const companyName = (body.company_name ?? "").trim();
    const url = (body.url ?? "").trim();
    if (!companyName || !url) {
      return jsonResp({ error: "company_name と url は必須です" }, 400);
    }

    // subscriptions のINSERTは service role が必要なので、
    // companies のINSERTも service role で一本化する。
    // user_id は認証済みユーザーのIDを必ず使う（フロントからは受け取らない）。
    const service = getServiceClient();

    // 既存company確認（再オンボーディング時の冪等性確保）
    const { data: existingCompany, error: existingErr } = await service
      .from("companies")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingErr) {
      console.error("[register-company] select companies failed:", existingErr);
      return jsonResp(
        {
          error: "会社情報の取得に失敗しました",
          detail: existingErr.message,
          code: existingErr.code,
        },
        500,
      );
    }

    let company = existingCompany;

    if (existingCompany) {
      // 既存レコードを更新（ユーザーが再度オンボーディングを試行した場合）
      const { data: updated, error: updateErr } = await service
        .from("companies")
        .update({
          company_name: companyName,
          url,
          industry: body.industry?.trim() || null,
          initial_concern: body.initial_concern?.trim() || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingCompany.id)
        .select()
        .single();
      if (updateErr || !updated) {
        console.error("[register-company] update companies failed:", updateErr);
        return jsonResp(
          {
            error: "会社情報の更新に失敗しました",
            detail: updateErr?.message,
            code: updateErr?.code,
          },
          500,
        );
      }
      company = updated;
    } else {
      // 新規INSERT
      const { data: inserted, error: insertErr } = await service
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
      if (insertErr || !inserted) {
        console.error("[register-company] insert companies failed:", insertErr);
        return jsonResp(
          {
            error: "会社情報の登録に失敗しました",
            detail: insertErr?.message,
            code: insertErr?.code,
            hint: insertErr?.hint,
          },
          500,
        );
      }
      company = inserted;
    }

    // subscriptions はサーバー側固定値で作成／既存確認
    const { data: existingSub, error: subSelErr } = await service
      .from("subscriptions")
      .select("id,status")
      .eq("company_id", company.id)
      .maybeSingle();

    if (subSelErr) {
      console.error(
        "[register-company] select subscriptions failed:",
        subSelErr,
      );
      return jsonResp(
        {
          error: "サブスクリプション確認に失敗しました",
          detail: subSelErr.message,
          code: subSelErr.code,
        },
        500,
      );
    }

    if (!existingSub) {
      const trialEndsAt = new Date(
        Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();

      const { error: subInsErr } = await service.from("subscriptions").insert({
        company_id: company.id,
        plan: "trial",
        status: "trialing",
        trial_ends_at: trialEndsAt,
        current_period_end: trialEndsAt,
      });

      if (subInsErr) {
        console.error(
          "[register-company] insert subscriptions failed:",
          subInsErr,
        );
        return jsonResp(
          {
            error: "サブスクリプション作成に失敗しました",
            detail: subInsErr.message,
            code: subInsErr.code,
            hint: subInsErr.hint,
          },
          500,
        );
      }
    }

    return jsonResp({ success: true, company }, 200);
  } catch (error) {
    console.error("[register-company] unexpected error:", error);
    captureError(error as Error, { extra: { user_id: user.id } });
    return jsonResp(
      {
        error: "会社登録に失敗しました",
        detail: (error as Error)?.message,
      },
      500,
    );
  }
});
