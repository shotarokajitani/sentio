// Investigator Edge Function — Planner → Generator → Evaluator pipeline
// Uses Anthropic API (model from ANTHROPIC_MODEL env var, ADR-0001)
// Reads prompts from filesystem at runtime (code embedding prohibited)

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import { resolveCaller, resolveCompanyId } from "../_shared/caller.ts";
import { errorResponse, mustData, mustMaybe, mustOk } from "../_shared/db.ts";
import { MAX_FULL_RUNS_PER_DAY, canRunFullHarness, budgetDateKey } from "../_shared/budget.ts";
import { FINDING_TEMPLATE, EVALUATOR_CRITERIA } from "../_shared/prompts.ts";
import { MODEL_GENERATOR, MODEL_EVALUATOR, warnIfModelDeprecated } from "../_shared/models.ts";
import Anthropic from "npm:@anthropic-ai/sdk@0.39.0";

const MAX_REVISIONS = 2;

interface Candidate {
  scanType: string;
  source: string;
  suggestedUrgency: string;
  evidence_event_ids: string[];
  description: string;
  score: number;
}

interface EvalCriterion {
  name: string;
  pass: boolean;
  reason: string;
}

// Prompts loaded via import from _shared/prompts.ts (Edge Runtime sandbox blocks readTextFile)

// Planner: cluster related candidates into investigation units
function planInvestigations(candidates: Candidate[]): Candidate[][] {
  // Group by scanType for now; related candidates are investigated together
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = c.scanType;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  return Array.from(groups.values());
}

// Generator: produce Finding draft with 3+ hypotheses via LLM
async function generate(
  client: Anthropic,
  model: string,
  candidates: Candidate[],
  memoryPacket: string,
  findingTemplate: string,
): Promise<{
  what: string;
  hypotheses: Array<{ text: string; plausibility: string }>;
  evidence_event_ids: string[];
  urgency: string;
  next_actions: Array<{ description: string; onetap_type?: string }>;
  rendered: string;
}> {
  const evidenceIds = candidates.flatMap((c) => c.evidence_event_ids);

  const { data: response, response: rawResponse } = await client.messages
    .create({
      model,
      max_tokens: 16000,
      messages: [
        {
          role: "user",
          content: `あなたはSentioのFinding生成器です。以下のシグナルと会社の記憶パケットから、Findingを生成してください。

## 検知されたシグナル
${JSON.stringify(candidates, null, 2)}

## 会社の記憶パケット
${memoryPacket}

## Findingテンプレート（この形式に従うこと）
${findingTemplate}

## 制約
- 仮説は必ず3件以上生成すること
- 全ての事実主張に証拠イベントIDを紐付けること
- 断定表現を使わないこと
- urgencyはweeklyまたはmonthlyのみ（immediateはmonitor/期日専用のため使用禁止）

以下のJSON形式で応答してください:
{
  "what": "何が変わったかの1-2文",
  "hypotheses": [{"text": "仮説文", "plausibility": "high|medium|low"}],
  "evidence_event_ids": ["イベントID配列"],
  "urgency": "weekly|monthly",
  "next_actions": [{"description": "次の一手", "onetap_type": "calendar|message_draft|employee_check|watch"}],
  "rendered": "テンプレートに従ったレンダリング済みテキスト"
}`,
        },
      ],
    })
    .withResponse();
  warnIfModelDeprecated(rawResponse.headers, model);

  const genTextBlock = response.content.find((c: { type: string }) => c.type === "text");
  const text =
    genTextBlock && "text" in genTextBlock
      ? (genTextBlock as { type: "text"; text: string }).text
      : "";

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    const parsed = JSON.parse(jsonMatch[0]);
    // Ensure evidence_event_ids includes all candidate evidence
    parsed.evidence_event_ids = [
      ...new Set([...evidenceIds, ...(parsed.evidence_event_ids || [])]),
    ];
    return parsed;
  } catch {
    // Fallback structured response
    return {
      what: candidates[0]?.description || "Unknown signal",
      hypotheses: [
        { text: "Primary hypothesis based on data pattern", plausibility: "high" },
        { text: "Alternative explanation", plausibility: "medium" },
        { text: "Low-probability scenario", plausibility: "low" },
      ],
      evidence_event_ids: evidenceIds,
      urgency:
        candidates[0]?.suggestedUrgency === "immediate"
          ? "weekly"
          : candidates[0]?.suggestedUrgency || "weekly",
      next_actions: [{ description: "Investigate further", onetap_type: "watch" }],
      rendered: text,
    };
  }
}

// Evaluator: judge Finding against 5 criteria (independent of Generator reasoning)
async function evaluate(
  client: Anthropic,
  model: string,
  finding: {
    what: string;
    evidence_event_ids: string[];
    hypotheses: Array<{ text: string; plausibility: string }>;
  },
  evidenceSummaries: Array<{ event_id: string; summary: string }>,
  criteriaText: string,
): Promise<{ criteria: EvalCriterion[]; result: "pass" | "revise" | "reject" }> {
  // D3 independence: only finding + evidence passed (no generator reasoning)
  const { data: evalResponse, response: evalRawResponse } = await client.messages
    .create({
      model,
      max_tokens: 16000,
      messages: [
        {
          role: "user",
          content: `あなたはSentioのEvaluatorです。以下のFindingを5つの基準で厳密に判定してください。

## 判定基準
${criteriaText}

## Finding
${JSON.stringify(finding, null, 2)}

## 証拠イベント
${JSON.stringify(evidenceSummaries, null, 2)}

以下のJSON配列で応答してください（5要素、各基準に対応）:
[{"name": "基準名", "pass": true/false, "reason": "判定理由"}]`,
        },
      ],
    })
    .withResponse();
  warnIfModelDeprecated(evalRawResponse.headers, model);

  const evalTextBlock = evalResponse.content.find((c: { type: string }) => c.type === "text");
  const text =
    evalTextBlock && "text" in evalTextBlock
      ? (evalTextBlock as { type: "text"; text: string }).text
      : "";

  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("No JSON array found");
    const criteria: EvalCriterion[] = JSON.parse(jsonMatch[0]);
    const allPass = criteria.every((c) => c.pass);
    return { criteria, result: allPass ? "pass" : "revise" };
  } catch {
    return {
      criteria: [
        { name: "image", pass: false, reason: "Evaluation parse failed" },
        { name: "evidence", pass: false, reason: "Evaluation parse failed" },
        { name: "dismissal", pass: false, reason: "Evaluation parse failed" },
        { name: "tone", pass: false, reason: "Evaluation parse failed" },
        { name: "action", pass: false, reason: "Evaluation parse failed" },
      ],
      result: "reject",
    };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 呼び出し元の判定は DBに触る前（契約 S-2-9）
  const caller = await resolveCaller(req);
  if (!caller.ok) return caller.response;

  try {
    const { company_id: bodyCompanyId, candidates } = (await req.json()) as {
      company_id: string;
      candidates: Candidate[];
    };

    const scope = resolveCompanyId(caller.caller, bodyCompanyId);
    if (!scope.ok) return scope.response;
    const company_id = scope.companyId;

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY must be set" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const client = new Anthropic({
      apiKey,
      defaultHeaders: { "anthropic-version": "2023-06-01" },
    });
    const supabase = getSupabaseAdmin();

    const findingTemplate = FINDING_TEMPLATE;
    const evaluatorCriteria = EVALUATOR_CRITERIA;

    // Build memory packet from company_summary
    const summaryData = await mustMaybe(
      supabase
        .from("company_summary")
        .select("content")
        .eq("company_id", company_id)
        .order("generated_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      "investigate: company_summary",
    );
    const memoryPacket = summaryData?.content || "(No company summary available yet)";

    // 調査予算（S-6-2 〜 S-6-6）。
    // 修復前は実在しない列（used / daily_limit）を引き、エラーを無視して null にしていた。
    // 「行が無ければ無制限」を廃し、行が無ければ作って 0 から数える
    const today = budgetDateKey(new Date());
    await mustOk(
      supabase
        .from("budget_usage")
        .upsert(
          { company_id, date: today, full_runs: 0, light_runs: 0 },
          { onConflict: "company_id,date", ignoreDuplicates: true },
        ),
      "investigate: budget_usage ensure",
    );

    const budgetRow = await mustMaybe(
      supabase
        .from("budget_usage")
        .select("full_runs, light_runs")
        .eq("company_id", company_id)
        .eq("date", today)
        .single(),
      "investigate: budget_usage",
    );

    let fullRuns = budgetRow.full_runs;
    let budgetStopped = false;

    // Plan investigations
    const investigations = planInvestigations(candidates);
    const findings = [];

    for (const group of investigations) {
      // 上限に達したら起動しない（fail-closed）。
      // 止めた事実をログとレスポンスの両方に残す。黙って0件で終わらせると、
      // 「候補が無かった」のか「予算で止めた」のかが区別できなくなる（S-6-6）
      if (!canRunFullHarness(fullRuns)) {
        budgetStopped = true;
        console.warn(
          `[sentio:budget] company_id=${company_id} date=${today} ` +
            `full_runs=${fullRuns}/${MAX_FULL_RUNS_PER_DAY} ` +
            `上限に達したためフルハーネスを起動しない（残り ${investigations.length - findings.length} 群を見送り）`,
        );
        break;
      }

      // Generator
      const draft = await generate(client, MODEL_GENERATOR, group, memoryPacket, findingTemplate);

      // Fetch evidence summaries for Evaluator
      const evidenceEvents = await mustData(
        supabase
          .from("events")
          .select("event_id, source, event_type, metrics, occurred_at")
          .in("event_id", draft.evidence_event_ids),
        "investigate: evidence events",
      );

      const evidenceSummaries = (evidenceEvents || []).map((e) => ({
        event_id: e.event_id,
        summary: `[${e.event_type}] ${e.source} @ ${e.occurred_at}: ${JSON.stringify(e.metrics)}`,
      }));

      // Evaluator loop (max 2 revisions)
      let evalResult = await evaluate(
        client,
        MODEL_EVALUATOR,
        {
          what: draft.what,
          evidence_event_ids: draft.evidence_event_ids,
          hypotheses: draft.hypotheses,
        },
        evidenceSummaries,
        evaluatorCriteria,
      );

      let revisions = 0;
      while (evalResult.result === "revise" && revisions < MAX_REVISIONS) {
        revisions++;
        // Re-generate with feedback
        const revised = await generate(
          client,
          MODEL_GENERATOR,
          group,
          memoryPacket,
          findingTemplate,
        );
        draft.what = revised.what;
        draft.hypotheses = revised.hypotheses;
        draft.evidence_event_ids = revised.evidence_event_ids;
        draft.next_actions = revised.next_actions;
        draft.rendered = revised.rendered;

        evalResult = await evaluate(
          client,
          MODEL_EVALUATOR,
          {
            what: draft.what,
            evidence_event_ids: draft.evidence_event_ids,
            hypotheses: draft.hypotheses,
          },
          evidenceSummaries,
          evaluatorCriteria,
        );
      }

      if (revisions >= MAX_REVISIONS && evalResult.result !== "pass") {
        evalResult.result = "reject";
      }

      if (evalResult.result === "pass") {
        // Store Finding in DB
        const findingId = crypto.randomUUID();
        const now = new Date().toISOString();
        await mustOk(
          supabase.from("findings").insert({
            id: findingId,
            company_id,
            status: "open",
            urgency: draft.urgency,
            what: draft.what,
            evidence_event_ids: draft.evidence_event_ids,
            confidence: 0.8,
            hypotheses: draft.hypotheses,
            next_actions: draft.next_actions,
            eval_log: {
              criteria: evalResult.criteria,
              revisions,
              result: evalResult.result,
            },
            parent_finding_id: null,
            created_at: now,
            updated_at: now,
          }),
          "investigate: findings insert",
        );

        findings.push({ id: findingId, what: draft.what, urgency: draft.urgency });
      }

      // 起動したら必ず数える。起動したのに full_runs が増えない状態を作らない（S-6-4）。
      // Finding が採択されたかどうかに関わらず、ハーネスは1回動いている
      fullRuns += 1;
      await mustOk(
        supabase
          .from("budget_usage")
          .update({ full_runs: fullRuns })
          .eq("company_id", company_id)
          .eq("date", today),
        "investigate: budget_usage increment",
      );
    }

    return new Response(
      JSON.stringify({
        status: "ok",
        company_id,
        findings,
        // 0件の原因を応答から区別できるようにする（S-2-3 / S-6-6）
        budget: {
          full_runs: fullRuns,
          limit: MAX_FULL_RUNS_PER_DAY,
          stopped_by_budget: budgetStopped,
        },
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    return errorResponse(error, corsHeaders);
  }
});
