import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

interface TypeStat {
  type: string;
  digits: number | null;
  sample_count: number;
  samples?: string[]; // Only present for date/number columns, never for string columns
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL;

  if (!apiKey || !model) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY / ANTHROPIC_MODEL not set" },
      { status: 500 },
    );
  }

  const { headers, row_count, type_stats } = (await req.json()) as {
    headers: string[];
    row_count: number;
    type_stats: Record<string, TypeStat>;
  };

  if (!headers || headers.length === 0) {
    return NextResponse.json({ error: "headers required" }, { status: 400 });
  }

  // Build column description for Claude (no string cell values - PII protection)
  const columnDescriptions = headers
    .map((h) => {
      const stat = type_stats[h];
      if (!stat) return `- "${h}": 型不明`;
      const parts = [`- "${h}": 型=${stat.type}, 件数=${stat.sample_count}`];
      if (stat.digits !== null) parts.push(`最大桁数=${stat.digits}`);
      if (stat.samples && stat.samples.length > 0) {
        // Only date/number samples are included (string samples are excluded at client)
        parts.push(`サンプル=[${stat.samples.join(", ")}]`);
      }
      return parts.join(", ");
    })
    .join("\n");

  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model,
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: `以下のCSVファイルのヘッダーと列の型統計から、入出金データの列マッピングを推定してください。

## CSVヘッダーと型統計
行数: ${row_count}
${columnDescriptions}

## マッピング先（Sentioスキーマ）
- date: 取引日・日付（日付型の列）
- description: 摘要・内容・メモ（文字列型の列）
- amount: 金額（数値型の列）
- direction: 入金/出金の区分列（文字列型。「入金」「出金」「収入」「支出」「deposit」「withdrawal」等。列がなく入金額・出金額が別列の場合はnull）
- credit: 入金額（数値型の列。directionがnullで入金/出金が別列の場合のみ）
- debit: 出金額（数値型の列。directionがnullで入金/出金が別列の場合のみ）
- balance: 残高（数値型の列、なければnull）

## 想定されるCSV形式
1. 銀行入出金明細: 日付, 摘要, お支払金額, お預り金額, 差引残高 等
2. Stripe入金レポートCSV: created, description, amount, fee, net, type 等
3. 弥生仕訳日記帳: 仕訳日付, 借方金額, 貸方金額, 摘要 等

以下のJSON形式のみで回答してください。他のテキストは不要です:
{"date":"列名","description":"列名","amount":"列名またはnull","direction":"列名またはnull","credit":"列名またはnull","debit":"列名またはnull","balance":"列名またはnull"}`,
      },
    ],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";

  // Extract JSON from response
  const jsonMatch = text.match(/\{[^}]+\}/);
  if (!jsonMatch) {
    return NextResponse.json({ error: "マッピング推定に失敗しました", raw: text }, { status: 500 });
  }

  try {
    const mapping = JSON.parse(jsonMatch[0]);
    // Validate that mapped columns exist in headers
    for (const [key, col] of Object.entries(mapping)) {
      if (col !== null && !headers.includes(col as string)) {
        mapping[key] = null;
      }
    }
    return NextResponse.json({ mapping });
  } catch {
    return NextResponse.json({ error: "JSON解析に失敗しました", raw: text }, { status: 500 });
  }
}
