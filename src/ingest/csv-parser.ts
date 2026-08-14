import { createHash } from "crypto";
import type { EventEnvelopeType } from "@shared/contracts/envelope";

/**
 * Deterministic event_id: SHA-256 of fingerprint + row content.
 * Same input always produces the same ID (B2 idempotency).
 * Changed rows produce different IDs (B3 diff detection).
 */
export function generateEventId(fingerprint: string, rowContent: string): string {
  return createHash("sha256").update(`${fingerprint}:${rowContent}`).digest("hex");
}

/**
 * Parse accounting CSV text into EventEnvelope objects.
 *
 * Expected CSV columns: date, description, amount, tax
 * Each row becomes one "transaction" event with S1 sensitivity.
 */
export function parseCsvToEnvelopes(
  csvText: string,
  fileFingerprint: string,
  companyId: string,
): EventEnvelopeType[] {
  const lines = csvText.trim().split("\n");
  if (lines.length < 2) return [];

  const headers = lines[0].split(",");
  const dateIdx = headers.indexOf("date");
  const descIdx = headers.indexOf("description");
  const amountIdx = headers.indexOf("amount");
  const taxIdx = headers.indexOf("tax");

  const now = new Date().toISOString();

  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    const rowContent = cols.join(",");

    return {
      event_id: generateEventId(fileFingerprint, rowContent),
      company_id: companyId,
      occurred_at: `${cols[dateIdx]}T00:00:00.000Z`,
      ingested_at: now,
      source: "csv:accounting",
      event_type: "transaction" as const,
      entity_refs: [],
      metrics: {
        amount: Number(cols[amountIdx]),
        tax: Number(cols[taxIdx]),
        description: cols[descIdx],
      },
      sensitivity: "S1" as const,
    };
  });
}
