// One-tap calendar Edge Function (E4)
// Creates calendar draft (never sends automatically)
// Confirmation via separate action — Sentio never auto-sends/registers
//
// メールは送らない。それでも冪等キーを持つのは、防ぐ対象が二重送信ではなく
// **二重の仮登録**だからである（再試行が下書きを2件作らないこと）。
// キーは onetap_calendar:<company_id>:<finding_id>:<recipient_id>:<action>。
// action を含めるのは、取りうる2値（create / confirm）が**それぞれ別の副作用を持つ**ため。

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { resolveCaller, resolveCompanyId } from "../_shared/caller.ts";
import { errorResponse, mustData, mustMaybe, mustOk, takeError } from "../_shared/db.ts";
import { deliveryKey } from "../_shared/delivery.ts";

const UNIQUE_VIOLATION = "23505";

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 呼び出し元の判定は**DBに触る前**（契約 S-2-9）
  const caller = await resolveCaller(req);
  if (!caller.ok) return caller.response;

  try {
    // **ボディの読み取りは1回だけ。** 修復前は confirm 分岐で `await req.json()` を
    // 2回目に呼んでおり、Body は既に消費済みなので **confirm は必ず 500 になっていた**。
    // 呼び出し元が0件だったため表に出ていなかった（2026-08-20 実測）
    const body = await req.json();
    const { company_id, finding_id, recipient_id, action, draft_id } = body;

    const scope = resolveCompanyId(caller.caller, company_id);
    if (!scope.ok) return scope.response;
    const companyId = scope.companyId;

    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();

    if (action === "create") {
      if (!finding_id || !recipient_id) {
        return json(400, { error: "finding_id and recipient_id are required" });
      }

      const key = deliveryKey({
        kind: "onetap_calendar",
        companyId,
        findingId: finding_id,
        recipientId: recipient_id,
        action: "create",
      });

      const draftId = crypto.randomUUID();

      // 一意制約違反は「既に下書きがある」という正常な分岐なので値で受ける
      const insertError = await takeError(
        supabase.from("delivery_log").insert({
          id: draftId,
          company_id: companyId,
          channel: "calendar",
          delivery_type: "onetap_calendar",
          content: {
            finding_id,
            recipient_id,
            status: "draft",
            sent_at: null,
            registered_at: null,
          },
          status: "draft",
          attempts: 0,
          idempotency_key: key,
          created_at: now,
        }),
        "onetap-calendar: create draft",
      );

      if (insertError && insertError.code !== UNIQUE_VIOLATION) throw insertError;

      if (insertError) {
        // 同じ Finding × 宛先の下書きが既にある。2件目を作らない
        const existing = await mustMaybe<{ id: string; status: string }>(
          supabase
            .from("delivery_log")
            .select("id, status")
            .eq("idempotency_key", key)
            .maybeSingle(),
          "onetap-calendar: read existing draft",
        );

        if (!existing) {
          throw new Error(`一意制約に違反したが該当行が無い: ${key}`);
        }

        return json(200, {
          status: "skipped",
          reason: "already-drafted",
          draft_id: existing.id,
          draft_status: existing.status,
          action: "created",
        });
      }

      return json(200, { status: "ok", draft_id: draftId, action: "created" });
    }

    if (action === "confirm") {
      if (!draft_id) {
        return json(400, { error: "draft_id is required" });
      }

      const existing = await mustMaybe<{
        id: string;
        content: Record<string, unknown>;
        status: string;
        company_id: string;
      }>(
        supabase
          .from("delivery_log")
          .select("id, content, status, company_id")
          .eq("id", draft_id)
          .maybeSingle(),
        "onetap-calendar: read draft",
      );

      // 0件は正常系として 404 で返す（エラーと区別できる。契約 S-2-3）
      if (!existing || existing.company_id !== companyId) {
        return json(404, { error: "Draft not found" });
      }

      if (existing.status === "confirmed") {
        return json(200, { status: "skipped", reason: "already-confirmed", draft_id });
      }

      await mustOk(
        supabase
          .from("delivery_log")
          .update({
            status: "confirmed",
            content: { ...existing.content, status: "confirmed", registered_at: now },
          })
          .eq("id", draft_id),
        "onetap-calendar: confirm draft",
      );

      return json(200, { status: "ok", draft_id, action: "confirmed" });
    }

    return json(400, { error: "action must be 'create' or 'confirm'" });
  } catch (error) {
    return errorResponse(error, corsHeaders);
  }
});
