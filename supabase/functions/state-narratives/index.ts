// State-narratives Edge Function — 会社の文脈記憶を1件 upsert する
//
// **これは「夜間バッチの1段」ではない**（契約 P-2 / S-3-4）。
// `category` と `topic` を呼び出し元が渡す**イベント駆動の単発API**であり、
// `company_id` だけを渡して呼べる形ではない。
// `state-baselines → state-narratives → state-summary` と一列に並べる cron 設計は
// 成り立たないので、夜間の記銘経路は baselines 再計算と summary 再生成の2本にする。
//
// 実列は category / topic / content / confidence / source_event_ids（複数）/
// last_confirmed_at / decayed_at。
// 修復前は `key` / `updated_at` / `source_event_id`（単数）を読み書きしており、
// いずれも実在しないため 42703 になっていた（P-2）。

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { resolveCaller, resolveCompanyId } from "../_shared/caller.ts";
import { errorResponse, mustMaybe, mustOk } from "../_shared/db.ts";
import { decayedConfidence } from "../_shared/narrative-confidence.ts";

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

interface NarrativeRow {
  id: string;
  content: string;
  confidence: number;
  source_event_ids: string[] | null;
  last_confirmed_at: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 呼び出し元の判定は DBに触る前（契約 S-2-9）
  const caller = await resolveCaller(req);
  if (!caller.ok) return caller.response;

  try {
    const {
      company_id: bodyCompanyId,
      category,
      topic,
      content,
      source_event_ids,
      is_correction,
    } = await req.json();

    const scope = resolveCompanyId(caller.caller, bodyCompanyId);
    if (!scope.ok) return scope.response;
    const company_id = scope.companyId;

    // 同定に要る3つが揃わないと upsert 先が決まらない。**DBに触る前に**落とす
    if (!category || !topic || typeof content !== "string" || content.length === 0) {
      return json(400, { error: "category, topic, content are required" });
    }

    const sourceEventIds: string[] = Array.isArray(source_event_ids)
      ? source_event_ids.filter((id: unknown): id is string => typeof id === "string")
      : [];

    const supabase = getSupabaseAdmin();
    const now = new Date();
    const nowIso = now.toISOString();

    // 自然キーは (company_id, category, topic)
    const existing = await mustMaybe<NarrativeRow>(
      supabase
        .from("narratives")
        .select("id, content, confidence, source_event_ids, last_confirmed_at")
        .eq("company_id", company_id)
        .eq("category", category)
        .eq("topic", topic)
        .maybeSingle(),
      "state-narratives: existing",
    );

    // 訂正は**即時に confidence を落とす**（時間減衰を待たない。`.claude/rules/state.md`）。
    // 「違う」と言われた記憶を持ち続けるほうが害が大きい
    if (is_correction) {
      if (!existing) {
        // 0件は正常系として区別できる形で返す（S-2-3）。訂正の対象が無い
        return json(404, { error: "narrative not found", category, topic });
      }

      await mustOk(
        supabase
          .from("narratives")
          .update({
            content,
            confidence: 0,
            source_event_ids: mergeEventIds(existing.source_event_ids, sourceEventIds),
            last_confirmed_at: nowIso,
            decayed_at: nowIso,
          })
          .eq("id", existing.id),
        "state-narratives: correction update",
      );

      return json(200, {
        status: "ok",
        action: "corrected",
        category,
        topic,
        confidence: 0,
      });
    }

    if (existing) {
      // 再確認されたので confidence を 1 に戻し、last_confirmed_at を進める
      await mustOk(
        supabase
          .from("narratives")
          .update({
            content,
            confidence: 1,
            source_event_ids: mergeEventIds(existing.source_event_ids, sourceEventIds),
            last_confirmed_at: nowIso,
          })
          .eq("id", existing.id),
        "state-narratives: update",
      );

      return json(200, {
        status: "ok",
        action: "updated",
        category,
        topic,
        confidence: 1,
        // 直前の値がどこまで減衰していたかを返す。再確認の意味が呼び出し元から見える
        previous_confidence: decayedConfidence(
          existing.confidence,
          existing.last_confirmed_at,
          now,
        ),
      });
    }

    await mustOk(
      supabase.from("narratives").insert({
        company_id,
        category,
        topic,
        content,
        confidence: 1,
        source_event_ids: sourceEventIds,
        last_confirmed_at: nowIso,
      }),
      "state-narratives: insert",
    );

    return json(200, { status: "ok", action: "created", category, topic, confidence: 1 });
  } catch (error) {
    return errorResponse(error, corsHeaders);
  }
});

/** 根拠イベントは積み上げる。上書きすると「何を根拠に持った記憶か」が消える。 */
function mergeEventIds(existing: string[] | null, incoming: string[]): string[] {
  return [...new Set([...(existing ?? []), ...incoming])];
}
