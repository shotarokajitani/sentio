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

    const baselines = await mustData(
      supabase.from("baselines").select("metric_key, is_established").eq("company_id", companyId),
      "deliver-weekly: baselines",
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

    const established = baselines.filter((b) => b.is_established);
    const totalBaselines = baselines.length;
    const activeProviders = connections.filter((c) => c.status === "active").map((c) => c.provider);

    const topFindings = findings.slice(0, 2);
    const findingCount = topFindings.length;

    const sources: string[] = [];
    if (activeProviders.includes("google_calendar")) sources.push(`カレンダー(${calCount}件)`);
    if (csvCount > 0) sources.push(`会計CSV(暫定集計・${csvCount}件)`);
    if (activeProviders.includes("freee")) sources.push("freee会計");
    const sourceSummary =
      sources.length > 0
        ? `データソース: ${sources.join("、")}。`
        : "データソース: まだ接続されていません。";

    const sections = [
      {
        type: "digest",
        content:
          findingCount > 0
            ? `今週は${findingCount}件のFindingがあります。${established.length}指標を追跡中です。${sourceSummary}`
            : `${sourceSummary}${totalBaselines > 0 ? `全${established.length}指標が安定しています。` : "基準値はデータ蓄積後に確立されます。"}`,
      },
      {
        type: "finding",
        content: topFindings.length > 0 ? topFindings.map((f) => `- ${f.what}`).join("\n") : "",
      },
      {
        type: "followup",
        content:
          findings
            .filter((f) => f.status === "watching")
            .map((f) => `- 経過観察中: ${f.what}`)
            .join("\n") || "",
      },
      {
        type: "stable_coverage",
        content:
          totalBaselines > 0
            ? `${established.length}指標が平常。カバレッジ: ${totalBaselines}指標中${established.length}指標が確立済み。`
            : `カバレッジ: ${sources.length}データソース接続済み。基準値はデータ蓄積後に確立されます。`,
      },
      {
        type: "nudge",
        content:
          !activeProviders.includes("google_calendar") ||
          csvCount === 0 ||
          established.length < totalBaselines
            ? "データソースを追加接続すると、より多くの指標を監視できます。"
            : "",
      },
    ];

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
