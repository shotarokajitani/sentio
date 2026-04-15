import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.39.0";
import { initSentry, captureError } from "../_shared/sentry.ts";
import {
  getServiceClient,
  getUserClient,
  corsHeaders,
} from "../_shared/supabase.ts";

initSentry("analyze-financial-pdf");

const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function bufferToBase64(buf: ArrayBuffer): string {
  // Denoで大きめバイト列をbase64化する簡潔な実装。
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Claudeから返却された数値を検査して、シグナル化すべき兆候を抽出する。
// - 売上 ↑ かつ 営業利益 ↓ → パターン2（成長と実態の矛盾・high）
// - 売上 ↑ かつ 営業CF マイナス → パターン2（成長と実態の矛盾・high）
// - 営業利益率の悪化 → パターン2（medium）
// - 現預金の急減 → パターン8（沈黙のシグナル・high）
interface Finding {
  pattern_id: number;
  strength: "high" | "medium" | "low";
  direction: "risk" | "opportunity" | "silence";
  description: string;
  evidence: Record<string, unknown>;
}

function analyzeFindings(summary: Record<string, unknown>): Finding[] {
  const findings: Finding[] = [];
  const rev = Number(summary.revenue_trend_pct ?? NaN);
  const opProfit = Number(summary.operating_profit_trend_pct ?? NaN);
  const opCf = Number(summary.operating_cash_flow ?? NaN);
  const opMarginDelta = Number(summary.operating_margin_delta_pt ?? NaN);
  const cashDelta = Number(summary.cash_delta_pct ?? NaN);

  if (isFinite(rev) && isFinite(opProfit) && rev > 5 && opProfit < -5) {
    findings.push({
      pattern_id: 2,
      strength: "high",
      direction: "risk",
      description: `売上は前年比${rev.toFixed(1)}%増加している一方、営業利益は${opProfit.toFixed(1)}%減少しています。`,
      evidence: {
        revenue_trend_pct: rev,
        operating_profit_trend_pct: opProfit,
      },
    });
  }
  if (isFinite(rev) && isFinite(opCf) && rev > 5 && opCf < 0) {
    findings.push({
      pattern_id: 2,
      strength: "high",
      direction: "risk",
      description: `売上は伸びているのに営業キャッシュフローはマイナスです。成長と資金繰りの乖離が起きています。`,
      evidence: {
        revenue_trend_pct: rev,
        operating_cash_flow: opCf,
      },
    });
  }
  if (isFinite(opMarginDelta) && opMarginDelta < -2) {
    findings.push({
      pattern_id: 2,
      strength: "medium",
      direction: "risk",
      description: `営業利益率が前期比${opMarginDelta.toFixed(1)}ポイント悪化しています。`,
      evidence: { operating_margin_delta_pt: opMarginDelta },
    });
  }
  if (isFinite(cashDelta) && cashDelta < -20) {
    findings.push({
      pattern_id: 8,
      strength: "high",
      direction: "silence",
      description: `現預金残高が${Math.abs(cashDelta).toFixed(1)}%減少しています。資金の流出が進んでいる可能性があります。`,
      evidence: { cash_delta_pct: cashDelta },
    });
  }
  return findings;
}

serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });

  try {
    // JWT検証
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResp({ error: "認証が必要です" }, 401);
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    const userClient = getUserClient(authHeader);
    const {
      data: { user },
      error: authErr,
    } = await userClient.auth.getUser(jwt);
    if (authErr || !user) return jsonResp({ error: "認証が必要です" }, 401);

    const form = await req.formData();
    const file = form.get("file");
    const companyId = form.get("company_id");
    if (!(file instanceof File))
      return jsonResp({ error: "file が必要です" }, 400);
    if (file.type !== "application/pdf")
      return jsonResp({ error: "PDF形式のみ受け付けます" }, 400);
    if (!companyId || typeof companyId !== "string")
      return jsonResp({ error: "company_id が必要です" }, 400);
    if (file.size > 20 * 1024 * 1024)
      return jsonResp({ error: "ファイルサイズが20MBを超えています" }, 400);

    // 所有権チェック（RLS下）
    const { data: company } = await userClient
      .from("companies")
      .select("id, company_name")
      .eq("id", companyId)
      .single();
    if (!company) return jsonResp({ error: "権限がありません" }, 403);

    const arrayBuf = await file.arrayBuffer();
    const base64Pdf = bufferToBase64(arrayBuf);

    // Claude APIでPDFを解析。PDFそのものは保存せず、抽出された数値のみ扱う。
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: base64Pdf,
              },
            },
            {
              type: "text",
              text: `あなたは決算書・月次試算表を読み取る財務アナリストです。
添付PDFから以下の数値をJSONで抽出してください。PDFの本文・レイアウト・社名・住所は出力しないでください。

【抽出対象（JSON形式）】
{
  "period_label": "対象期間の表記（例: 2026年3月期 / 2026年3月度）",
  "revenue": "売上高の金額（数値・百万円単位で可）。不明なら null",
  "gross_profit": "粗利（売上総利益）。不明なら null",
  "operating_profit": "営業利益。不明なら null",
  "ordinary_profit": "経常利益。不明なら null",
  "operating_cash_flow": "営業活動によるキャッシュフロー。不明なら null",
  "cash_balance": "現預金残高。不明なら null",
  "revenue_trend_pct": "前年・前期比の売上変化率（%、増加ならプラス）。不明なら null",
  "operating_profit_trend_pct": "前年・前期比の営業利益変化率（%）。不明なら null",
  "operating_margin_delta_pt": "営業利益率の前期比変化（ポイント）。不明なら null",
  "cash_delta_pct": "現預金残高の前期比変化率（%）。不明なら null"
}

【出力ルール】
- JSONのみ出力。前後の説明文は一切書かない。
- 数値は円単位でも百万円単位でも構わないが、同じ指標は同じ単位で揃える。
- PDFに含まれない項目は null を返す。
- 推測はせず、PDFに明記された数値だけ返す。`,
            },
          ],
        },
      ],
    });

    // 返却テキストからJSONを抽出
    const textBlock = message.content.find((c) => c.type === "text");
    const raw =
      textBlock && "text" in textBlock
        ? (textBlock as { text: string }).text
        : "";
    let summary: Record<string, unknown> = {};
    try {
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start >= 0 && end > start) {
        summary = JSON.parse(raw.slice(start, end + 1));
      }
    } catch (e) {
      captureError(e as Error, {
        company_id: companyId,
        extra: { stage: "parse_claude_response", raw_length: raw.length },
      });
    }

    // 兆候検出 → signalsテーブルへ挿入
    const findings = analyzeFindings(summary);
    const service = getServiceClient();
    const now = Date.now();
    const expiresAt = new Date(now + 28 * 24 * 60 * 60 * 1000).toISOString();
    let signalsCreated = 0;

    for (const f of findings) {
      const { error: insErr } = await service.from("signals").insert({
        company_id: companyId,
        pattern_id: f.pattern_id,
        strength: f.strength,
        direction: f.direction,
        source: "system",
        external_data_refs: null,
        internal_data_refs: {
          source: "financial_pdf",
          period: summary.period_label ?? null,
        },
        description: f.description,
        evidence: f.evidence,
        status: "detected",
        expires_at: expiresAt,
      });
      if (!insErr) signalsCreated++;
    }

    // 画面表示用の短い findings 文字列リスト
    const displayFindings = findings.map((f) => f.description);

    return jsonResp({
      success: true,
      summary,
      findings: displayFindings,
      signals_created: signalsCreated,
    });
  } catch (e) {
    captureError(e as Error);
    return jsonResp({ error: (e as Error).message }, 500);
  }
});
