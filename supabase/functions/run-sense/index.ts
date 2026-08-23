// run-sense: Orchestrator Edge Function
// Connects scan → investigate → findings INSERT pipeline.
// Immediate candidates (monitor/deadline) bypass Investigator and INSERT directly.
// Called by pg_cron daily or manually for testing.

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { resolveCaller, resolveCompanyId } from "../_shared/caller.ts";
import { mustData, mustOk, errorResponse } from "../_shared/db.ts";
import { resolveInvestigateUrl } from "../_shared/investigate-url.ts";

interface ScanCandidate {
  scanType: string;
  source: string;
  suggestedUrgency: string;
  evidence_event_ids: string[];
  description: string;
  score: number;
}

interface ScanResponse {
  status: string;
  company_id: string;
  total_candidates: number;
  immediate_count: number;
  investigation_count: number;
  immediates: ScanCandidate[];
  candidates: ScanCandidate[];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 呼び出し元の判定は DBに触る前（契約 S-2-9）
  const caller = await resolveCaller(req);
  if (!caller.ok) return caller.response;

  try {
    const { company_id: bodyCompanyId } = await req.json();

    const scope = resolveCompanyId(caller.caller, bodyCompanyId);
    if (!scope.ok) return scope.response;
    const company_id = scope.companyId;

    const supabase = getSupabaseAdmin();
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    // Step 1: Call scan
    const scanRes = await fetch(`${supabaseUrl}/functions/v1/scan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({ company_id }),
    });

    if (!scanRes.ok) {
      const errText = await scanRes.text();
      return new Response(
        JSON.stringify({ error: `scan failed: ${scanRes.status}`, detail: errText }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const scanResult: ScanResponse = await scanRes.json();

    // Step 2: Insert immediate candidates directly into findings (fast path)
    // These are mechanical facts (monitor down, deadline overdue) — no LLM needed
    const insertedImmediates: string[] = [];
    for (const imm of scanResult.immediates) {
      // Dedup: check if an open finding already exists for same evidence
      const existing = await mustData(
        supabase
          .from("findings")
          .select("id")
          .eq("company_id", company_id)
          .in("status", ["open", "watching"])
          .contains("evidence_event_ids", imm.evidence_event_ids)
          .limit(1),
        "run-sense: findings dedup",
      );

      if (existing && existing.length > 0) {
        // D6: same event → update, not new finding
        await mustOk(
          supabase
            .from("findings")
            .update({ updated_at: new Date().toISOString() })
            .eq("id", existing[0].id),
          "run-sense: findings touch",
        );
        continue;
      }

      const findingId = crypto.randomUUID();
      // 挿入の失敗を握りつぶさない。修復前は if (!insertErr) で握りつぶしており、
      // 「findings が0件」の原因が挿入失敗なのか候補ゼロなのか区別できなかった
      await mustOk(
        supabase.from("findings").insert({
          id: findingId,
          company_id,
          status: "open",
          urgency: "immediate",
          what: imm.description,
          evidence_event_ids: imm.evidence_event_ids,
          confidence: 1.0, // Mechanical fact, no uncertainty
          hypotheses: {},
          next_actions: {},
          eval_log: { source: "fast_path", scanType: imm.scanType },
          parent_finding_id: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
        "run-sense: findings insert",
      );

      insertedImmediates.push(findingId);
    }

    // Step 3: Pass non-immediate candidates to Investigator
    let investigateResult = {
      findings: [] as Array<{ id: string; what: string; urgency: string }>,
    };

    if (scanResult.candidates.length > 0) {
      // 宛先だけ env で差し替え可能にする（契約 S-3-1）。
      // 未設定なら self URL に倒れるので、本番の既定挙動は変わらない
      const investigateRes = await fetch(resolveInvestigateUrl(undefined, supabaseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        body: JSON.stringify({ company_id, candidates: scanResult.candidates }),
      });

      // investigate の失敗を握りつぶさない。修復前は静かに findings 0件で 200 を返しており、
      // 「調査が落ちた」と「調査対象が無かった」が応答から区別できなかった（S-2-3）
      if (!investigateRes.ok) {
        const detail = await investigateRes.text();
        return new Response(
          JSON.stringify({
            error: `investigate failed: ${investigateRes.status}`,
            detail,
            immediates_inserted: insertedImmediates.length,
          }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      investigateResult = await investigateRes.json();
    }

    return new Response(
      JSON.stringify({
        status: "ok",
        company_id,
        scan: {
          total_candidates: scanResult.total_candidates,
          immediate_count: scanResult.immediate_count,
          investigation_count: scanResult.investigation_count,
        },
        immediates_inserted: insertedImmediates.length,
        findings_from_investigator: investigateResult.findings.length,
        total_findings: insertedImmediates.length + investigateResult.findings.length,
        finding_ids: [...insertedImmediates, ...investigateResult.findings.map((f) => f.id)],
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    return errorResponse(error, corsHeaders);
  }
});
