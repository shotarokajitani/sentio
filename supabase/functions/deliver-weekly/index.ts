// Weekly email delivery Edge Function
// Renders weekly report sections and sends via Resend
// Section order: digest → finding (0-2) → followup → stable_coverage → nudge (E1)
//
// 送信順序は「予約 → 送信 → 結果でUPDATE」（契約 S-2-7）。
// 冪等キーは weekly:<company_id>:<ISO週>。target_week の明示指定が導出より優先される。

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { renderWeeklyHtml, renderWeeklyText } from "../_shared/email-html.ts";
import { resolveCaller, resolveCompanyId } from "../_shared/caller.ts";
import { errorResponse, mustCount, mustData } from "../_shared/db.ts";
import { resolveMailConfig, sendEmail } from "../_shared/mailer.ts";
import {
  asDeliveryDb,
  deliverOnce,
  deliveryKey,
  isInvalidPeriodError,
  resolveWeeklyPeriod,
} from "../_shared/delivery.ts";
import { deliveryResponse } from "../_shared/delivery-response.ts";
import {
  jstWeekRange,
  summarizeWeek,
  MEETING_EVENT_TYPE,
  MEETING_SOURCE,
  type EventRow,
} from "../../../shared/report/weekly.ts";
import { buildWeeklySections, weekReference } from "../_shared/weekly-sections.ts";

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
    const { company_id, email, target_week } = await req.json();

    const scope = resolveCompanyId(caller.caller, company_id);
    if (!scope.ok) return scope.response;
    const companyId = scope.companyId;

    if (!email) {
      return json(400, { error: "email is required" });
    }

    const now = new Date();

    // 対象期間は**DBにも外部にも触る前**に決める（deliver-pulse と同じ理由）
    let period: string;
    try {
      period = resolveWeeklyPeriod(now, target_week);
    } catch (e) {
      if (isInvalidPeriodError(e)) return json(400, { error: e.message });
      throw e;
    }

    const mail = resolveMailConfig();
    if (!mail.ok) {
      return json(500, {
        status: "error",
        reason: `${mail.missing.join(" / ")} が未設定。送信せずに停止しました`,
        company_id: companyId,
      });
    }

    const supabase = getSupabaseAdmin();

    const findings = await mustData(
      supabase
        .from("findings")
        .select("id, what, urgency, next_actions, status, updated_at")
        .eq("company_id", companyId)
        .in("status", ["open", "watching"])
        .order("updated_at", { ascending: false }),
      "deliver-weekly: findings",
    );

    // 対象週は `period` から導く。`new Date()` を渡すと、`target_week` を指定したときに
    // **件名の週と本文の数字がずれる**（契約 落とし穴2）
    const reference = weekReference(period);
    const week = jstWeekRange(reference);
    // 前週比のために前週の頭から取る。画面側（`src/lib/report/events.ts`）と同じ窓
    const from = jstWeekRange(new Date(week.start.getTime() - 1)).start;

    // `*` を書かない。`check:schema`（S-5-1）が参照列を静的に読めなくなる（契約 落とし穴3）
    const weeklyEvents = await mustData(
      supabase
        .from("events")
        .select("source, event_type, period_start, period_end, metrics")
        .eq("company_id", companyId)
        .eq("source", MEETING_SOURCE)
        .eq("event_type", MEETING_EVENT_TYPE)
        .gte("period_start", from.toISOString())
        .lt("period_start", week.end.toISOString()),
      "deliver-weekly: weekly events",
    );

    const connections = await mustData(
      supabase.from("connections").select("provider, status").eq("company_id", companyId),
      "deliver-weekly: connections",
    );

    // count は data を返さないので mustCount で受ける。
    // ここだけ生の分割代入に戻すと、そこが検査の穴になる。
    // head: true なので行は1件も返らないが、`*` ではなく列名を書く。
    // `*` のままだと check:schema（S-5-1）が参照列を静的に読めず、
    // 列の消失・改名を検出できない穴になる
    const csvCount = await mustCount(
      supabase
        .from("events")
        .select("event_id", { count: "exact", head: true })
        .eq("company_id", companyId)
        .eq("source", "csv:accounting"),
      "deliver-weekly: csv event count",
    );

    const calCount = await mustCount(
      supabase
        .from("events")
        .select("event_id", { count: "exact", head: true })
        .eq("company_id", companyId)
        .eq("source", "google_calendar"),
      "deliver-weekly: calendar event count",
    );

    const activeProviders = connections.filter((c) => c.status === "active").map((c) => c.provider);

    // 画面（`/report`）と同じ `summarizeWeek` を使う。メール側で数え直さない（WM-1-2）
    const summary = summarizeWeek(weeklyEvents as EventRow[], reference);

    const sections = buildWeeklySections({
      summary,
      findings,
      activeProviders,
      csvCount,
      calCount,
    });

    const result = await deliverOnce(
      asDeliveryDb(supabase),
      {
        companyId,
        channel: "email",
        deliveryType: "weekly",
        idempotencyKey: deliveryKey({ kind: "weekly", companyId, period }),
        content: { sections, period },
        now,
      },
      () =>
        sendEmail(mail.config, {
          to: email,
          subject: "[Sentio] 今週の会社",
          html: renderWeeklyHtml(sections),
          text: renderWeeklyText(sections),
        }),
    );

    return deliveryResponse(result, { company_id: companyId, period, sections });
  } catch (error) {
    return errorResponse(error, corsHeaders);
  }
});
