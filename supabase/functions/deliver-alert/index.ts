// Immediate alert delivery Edge Function
// Facts + link only, no interpretation (E3)
// Respects quiet hours 23:00-06:00 JST with site_down exception (E5)
//
// 送信順序は「予約 → 送信 → 結果でUPDATE」（契約 S-2-7）。
// 冪等キーは alert:<company_id>:<event_id>。category は入れない（S-D6）。

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { renderAlertHtml, renderAlertText } from "../_shared/email-html.ts";
import { resolveCaller, resolveCompanyId } from "../_shared/caller.ts";
import { errorResponse } from "../_shared/db.ts";
import { resolveMailConfig, sendEmail } from "../_shared/mailer.ts";
import { deliverOnce, deliveryKey } from "../_shared/delivery.ts";
import { deliveryResponse } from "../_shared/delivery-response.ts";

const QUIET_HOUR_EXCEPTIONS = new Set(["site_down"]);
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function isQuietHour(date: Date): boolean {
  const jstTime = new Date(date.getTime() + JST_OFFSET_MS);
  const hour = jstTime.getUTCHours();
  return hour >= 23 || hour < 6;
}

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
    const { company_id, event, email, category } = await req.json();

    const scope = resolveCompanyId(caller.caller, company_id);
    if (!scope.ok) return scope.response;
    const companyId = scope.companyId;

    // 冪等キーの対象IDは event_id。**DBにも外部にも触る前に**検証する。
    // 欠落したまま進むと、キーが作れないか、作れても一意でなくなる
    const eventId = event?.event_id;
    if (!eventId || typeof eventId !== "string") {
      return json(400, {
        error: "event.event_id is required（冪等キーの対象IDとして必須）",
      });
    }

    if (!email) {
      return json(400, { error: "email is required" });
    }

    const now = new Date();
    const supabase = getSupabaseAdmin();

    // E3: 事実のみ。解釈を入れない
    const metrics = event.metrics || {};
    const subject =
      metrics.status === "down"
        ? `[Alert] サイトダウン: ${metrics.url || "unknown"}`
        : `[Alert] ${category}: ${metrics.expected_date || event.occurred_at}`;

    const alertContent = {
      subject,
      body: `${Object.entries(metrics)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n")}\n検出時刻: ${event.occurred_at}`,
    };

    const key = deliveryKey({ kind: "alert", companyId, eventId });

    // E5: 静音時間は送らずに繰り延べを**記録**する。
    // 繰り延べ行と、その後の実送信行は**同じ冪等キーを共有する**必要があるため、
    // delivery_type は 'alert' のまま status で表す（00024 で alert_deferred を廃止）
    if (isQuietHour(now) && !QUIET_HOUR_EXCEPTIONS.has(category)) {
      const deferred = await deliverOnce(
        supabase,
        {
          companyId,
          channel: "email",
          deliveryType: "alert",
          idempotencyKey: key,
          content: { ...alertContent, event_id: eventId, category },
          now,
          intent: "defer",
        },
        () => {
          throw new Error("繰り延べ経路では送信しない");
        },
      );
      return deliveryResponse(deferred, {
        company_id: companyId,
        reason: "quiet_hours",
        alert: alertContent,
      });
    }

    // 送信設定は**予約より前**に見る（E+3 / E+5）
    const mail = resolveMailConfig();
    if (!mail.ok) {
      return json(500, {
        status: "error",
        reason: `${mail.missing.join(" / ")} が未設定。送信せずに停止しました`,
        alert: alertContent,
      });
    }

    const result = await deliverOnce(
      supabase,
      {
        companyId,
        channel: "email",
        deliveryType: "alert",
        idempotencyKey: key,
        content: { ...alertContent, event_id: eventId, category },
        now,
      },
      () =>
        sendEmail(mail.config, {
          to: email,
          subject: alertContent.subject,
          html: renderAlertHtml(alertContent.subject, alertContent.body),
          text: renderAlertText(alertContent.subject, alertContent.body),
        }),
    );

    return deliveryResponse(result, { company_id: companyId, alert: alertContent });
  } catch (error) {
    return errorResponse(error, corsHeaders);
  }
});
