import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";

interface ColumnMapping {
  date: string;
  description: string | null;
  amount: string | null;
  direction: string | null;
  credit: string | null;
  debit: string | null;
  balance: string | null;
}

interface SkipReason {
  line: number;
  reason: string;
}

export async function POST(req: NextRequest) {
  const { csv_text, company_id, file_name, mapping } = (await req.json()) as {
    csv_text: string;
    company_id: string;
    file_name: string;
    mapping: ColumnMapping;
  };

  if (!csv_text || !company_id || !mapping || !mapping.date) {
    return NextResponse.json(
      { error: "csv_text, company_id, mapping (date) required" },
      { status: 400 },
    );
  }

  const hasAmount = !!mapping.amount;
  const hasCreditDebit = !!mapping.credit || !!mapping.debit;
  if (!hasAmount && !hasCreditDebit) {
    return NextResponse.json(
      { error: "mapping に amount か credit/debit のいずれかが必要です" },
      { status: 400 },
    );
  }

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const lines = csv_text.trim().split("\n");
  if (lines.length < 2) {
    return NextResponse.json({ count: 0, skipped: 0, total_lines: 0, skip_reasons: [] });
  }

  const headers = parseCSVLine(lines[0]);
  const idx = (col: string | null) => {
    if (!col) return -1;
    // Try exact match first, then trimmed match
    const i = headers.indexOf(col);
    if (i >= 0) return i;
    return headers.findIndex((h) => h.trim() === col.trim());
  };

  const dateIdx = idx(mapping.date);
  const descIdx = idx(mapping.description);
  const amountIdx = idx(mapping.amount);
  const directionIdx = idx(mapping.direction);
  const creditIdx = idx(mapping.credit);
  const debitIdx = idx(mapping.debit);
  const balanceIdx = idx(mapping.balance);

  if (dateIdx === -1) {
    return NextResponse.json(
      {
        error: `日付列「${mapping.date}」が見つかりません。CSV列: [${headers.join(", ")}]`,
        count: 0,
        skipped: 0,
        total_lines: lines.length - 1,
        skip_reasons: [],
      },
      { status: 400 },
    );
  }

  const now = new Date().toISOString();
  const fileFingerprint = `csv:${company_id}:${file_name}`;
  const rows = [];
  const skipReasons: SkipReason[] = [];
  const totalDataLines = lines.slice(1).filter((l) => l.trim()).length;

  for (let lineIdx = 1; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    if (!line.trim()) continue;
    const cols = parseCSVLine(line);

    const dateVal = cols[dateIdx]?.trim();
    if (!dateVal) {
      skipReasons.push({ line: lineIdx + 1, reason: "日付が空" });
      continue;
    }

    const normalizedDate = normalizeDate(dateVal);
    if (normalizedDate === "era_unsupported") {
      skipReasons.push({ line: lineIdx + 1, reason: "和暦は未対応" });
      continue;
    }
    if (!normalizedDate) {
      // Check if it looks like M/D (year-less)
      if (/^\d{1,2}[/-]\d{1,2}$/.test(dateVal.trim())) {
        skipReasons.push({ line: lineIdx + 1, reason: "年なし日付(M/D)は補完不可" });
      } else {
        skipReasons.push({ line: lineIdx + 1, reason: `日付解析失敗: "${dateVal}"` });
      }
      continue;
    }

    // Determine amount and direction
    let amount: number;
    let direction: "credit" | "debit" | "unknown";

    if (creditIdx >= 0 || debitIdx >= 0) {
      // 2-column format: separate credit/debit columns (bank statement standard)
      const creditVal = creditIdx >= 0 ? parseNumber(cols[creditIdx]) : 0;
      const debitVal = debitIdx >= 0 ? parseNumber(cols[debitIdx]) : 0;

      if (creditVal > 0 && debitVal > 0) {
        // Both have values: net them (unusual, treat credit as positive)
        amount = creditVal - debitVal;
        direction = amount >= 0 ? "credit" : "debit";
        amount = Math.abs(amount);
      } else if (creditVal > 0) {
        amount = creditVal;
        direction = "credit";
      } else if (debitVal > 0) {
        amount = debitVal;
        direction = "debit";
      } else {
        // Both are 0 or empty — still a valid row (e.g., balance-only entry)
        amount = 0;
        direction = "unknown";
      }
    } else {
      // Single amount column
      amount = parseNumber(cols[amountIdx]);

      if (directionIdx >= 0) {
        const dirVal = (cols[directionIdx] || "").trim().toLowerCase();
        if (
          dirVal.includes("入金") || dirVal.includes("収入") ||
          dirVal.includes("deposit") || dirVal.includes("credit")
        ) {
          direction = "credit";
        } else if (
          dirVal.includes("出金") || dirVal.includes("支出") ||
          dirVal.includes("withdrawal") || dirVal.includes("debit")
        ) {
          direction = "debit";
        } else {
          direction = amount >= 0 ? "credit" : "debit";
          amount = Math.abs(amount);
        }
      } else {
        direction = amount >= 0 ? "credit" : "debit";
        amount = Math.abs(amount);
      }
    }

    const description = descIdx >= 0 ? (cols[descIdx]?.trim() || "(不明)") : "(不明)";
    const balance = balanceIdx >= 0 ? parseNumber(cols[balanceIdx]) : null;

    const rowContent = cols.join(",");
    const eventId = createHash("sha256")
      .update(`${fileFingerprint}:${rowContent}`)
      .digest("hex");

    rows.push({
      event_id: eventId,
      company_id: company_id,
      occurred_at: `${normalizedDate}T00:00:00.000Z`,
      ingested_at: now,
      source: "csv:accounting",
      event_type: "transaction" as const,
      entity_refs: [],
      metrics: {
        description,
        amount: direction === "debit" ? -amount : amount,
        direction,
        ...(balance !== null ? { balance } : {}),
      },
      sensitivity: "S1",
    });
  }

  if (rows.length === 0) {
    // Summarize skip reasons for the user
    const reasonSummary: Record<string, number> = {};
    for (const s of skipReasons) {
      const key = s.reason.replace(/: ".*"/, "");
      reasonSummary[key] = (reasonSummary[key] || 0) + 1;
    }
    const summaryText = Object.entries(reasonSummary)
      .map(([reason, count]) => `${reason}: ${count}行`)
      .join("、");

    return NextResponse.json({
      count: 0,
      skipped: totalDataLines,
      total_lines: totalDataLines,
      skip_summary: summaryText || "データ行なし",
      skip_reasons: skipReasons.slice(0, 10),
    });
  }

  // Batch upsert
  const batchSize = 500;
  let totalInserted = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase
      .from("events")
      .upsert(batch, { onConflict: "event_id" });

    if (error) {
      return NextResponse.json(
        { error: `取込失敗 (行${i}〜): ${error.message}`, count: totalInserted },
        { status: 500 },
      );
    }
    totalInserted += batch.length;
  }

  return NextResponse.json({
    count: totalInserted,
    skipped: skipReasons.length,
    total_lines: totalDataLines,
    skip_summary: skipReasons.length > 0
      ? Object.entries(
          skipReasons.reduce<Record<string, number>>((acc, s) => {
            const key = s.reason.replace(/: ".*"/, "");
            acc[key] = (acc[key] || 0) + 1;
            return acc;
          }, {}),
        )
          .map(([reason, count]) => `${reason}: ${count}行`)
          .join("、")
      : null,
  });
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else if (ch !== "\r") {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function parseNumber(val: string | undefined): number {
  if (!val) return 0;
  // Remove commas, yen sign, spaces, quotes
  const cleaned = val.replace(/[,¥￥\s"]/g, "");
  if (cleaned === "" || cleaned === "-") return 0;
  const n = Number(cleaned);
  return isNaN(n) ? 0 : n;
}

/**
 * Normalize date string to YYYY-MM-DD.
 * Returns null for unparseable formats (caller records skip reason).
 * Returns "era_unsupported" for Japanese era dates (和暦).
 */
export function normalizeDate(val: string): string | null {
  const trimmed = val.trim();

  // 1. YYYYMMDD (8-digit, no separator)
  const ymdMatch = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (ymdMatch) {
    const [, y, m, d] = ymdMatch;
    return `${y}-${m}-${d}`;
  }

  // 2. YYYY/MM/DD or YYYY-MM-DD
  const slashMatch = trimmed.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (slashMatch) {
    const [, y, m, d] = slashMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  // 3. YYYY年M月D日
  const jpMatch = trimmed.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?/);
  if (jpMatch) {
    const [, y, m, d] = jpMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  // 4. M/D (year-less) — cannot resolve without context, skip
  const mdMatch = trimmed.match(/^(\d{1,2})[/-](\d{1,2})$/);
  if (mdMatch) {
    return null; // caller will record "年なし日付(M/D)は補完不可"
  }

  // 5. Japanese era (令和/R/平成/H etc.) — explicitly unsupported
  const eraMatch = trimmed.match(/^[令平昭RHS]/);
  if (eraMatch) {
    return "era_unsupported";
  }

  return null;
}
