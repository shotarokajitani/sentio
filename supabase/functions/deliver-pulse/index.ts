// Daily pulse Edge Function — 3 lines, 10 seconds
// Line 1-2: yesterday's facts. Line 3: state (normal/watching). Line 4: anomaly day only
//
// 送信順序は「予約 → 送信 → 結果でUPDATE」（契約 S-2-7）。
// 修復前はこの逆で、送信後のDB書き込みが失敗すると痕跡が残らず、再試行が2通目を出した。

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { renderPulseHtml, renderPulseText } from "../_shared/email-html.ts";
import { resolveCaller, resolveCompanyId } from "../_shared/caller.ts";
import { errorResponse, mustData } from "../_shared/db.ts";
import { resolveMailConfig, sendEmail } from "../_shared/mailer.ts";
import {
  asDeliveryDb,
  deliverOnce,
  deliveryKey,
  isInvalidPeriodError,
  resolvePulsePeriod,
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

  // 呼び出し元の判定は**DBに触る前**（契約 S-2-9）。順序が要件である
  const caller = await resolveCaller(req);
  if (!caller.ok) return caller.response;

  try {
    const { company_id, email, target_date } = await req.json();

    const scope = resolveCompanyId(caller.caller, company_id);
    if (!scope.ok) return scope.response;
    const companyId = scope.companyId;
    const supabase = getSupabaseAdmin();

    // 宛先が無いのに 200 ok を返すと「送ったつもり」が残る。呼び出し側の誤りとして落とす
    if (!email) {
      return json(400, { error: "email is required" });
    }

    const now = new Date();

    // 対象期間は**DBにも外部にも触る前**に決める。
    // 明示指定（target_date）があれば導出より優先する。導出は now 依存で
    // JST 日付境界をまたぐと1日ずれるため、手動再実行の冪等性は明示指定で担保する
    let period: string;
    try {
      period = resolvePulsePeriod(now, target_date);
    } catch (e) {
      if (isInvalidPeriodError(e)) return json(400, { error: e.message });
      throw e;
    }

    // 送信設定は**予約より前**に見る。送るつもりが無いのに予約行を作らない（E+3 / E+5）
    const mail = resolveMailConfig();
    if (!mail.ok) {
      return json(500, {
        status: "error",
        reason: `${mail.missing.join(" / ")} が未設定。送信せずに停止しました`,
        company_id: companyId,
      });
    }

    // 対象期間の窓。period の JST 1日ぶんを UTC に戻す
    const from = new Date(`${period}T00:00:00+09:00`);
    const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);

    const events = await mustData(
      supabase
        .from("events")
        .select("event_type, source")
        .eq("company_id", companyId)
        .gte("occurred_at", from.toISOString())
        .lt("occurred_at", to.toISOString()),
      "deliver-pulse: events",
    );

    const findings = await mustData(
      supabase
        .from("findings")
        .select("what, status")
        .eq("company_id", companyId)
        .in("status", ["open", "watching"]),
      "deliver-pulse: findings",
    );

    const watchingCount = findings.filter((f) => f.status === "watching").length;
    const openFindings = findings.filter((f) => f.status === "open");

    const eventCount = events.length;
    const lines = [
      `${period}: ${eventCount}件のイベントを記録`,
      eventCount > 0
        ? `主な種別: ${[...new Set(events.map((e) => e.event_type))].join(", ")}`
        : "特記事項なし",
      watchingCount > 0 ? `状態: ${watchingCount}件を経過観察中` : "状態: 平常",
    ];
    if (openFindings.length > 0) {
      lines.push(`注意: ${openFindings.length}件のFindingが未対応`);
    }

    const result = await deliverOnce(
      asDeliveryDb(supabase),
      {
        companyId,
        channel: "email",
        deliveryType: "pulse",
        idempotencyKey: deliveryKey({ kind: "pulse", companyId, period }),
        content: { lines, period },
        now,
      },
      () =>
        sendEmail(mail.config, {
          to: email,
          subject: "[Sentio] デイリーパルス",
          html: renderPulseHtml(lines),
          text: renderPulseText(lines),
        }),
    );

    return deliveryResponse(result, { company_id: companyId, period, pulse: lines });
  } catch (error) {
    return errorResponse(error, corsHeaders);
  }
});
