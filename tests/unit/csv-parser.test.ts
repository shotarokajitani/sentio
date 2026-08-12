import { describe, it, expect } from "vitest";
import { parseCsvToEnvelopes, generateEventId } from "@/ingest/csv-parser";

describe("CSV→EventEnvelope (B1-B3)", () => {
  const sampleCsv = `date,description,amount,tax
2026-06-01,売上A,100000,10000
2026-06-02,仕入B,-50000,-5000`;

  const fileFingerprint = "sha256:abc123";
  const companyId = "550e8400-e29b-41d4-a716-446655440000";

  it("B1: CSVを正しくtransactionイベントに変換する", () => {
    const envelopes = parseCsvToEnvelopes(sampleCsv, fileFingerprint, companyId);
    expect(envelopes).toHaveLength(2);
    expect(envelopes[0].event_type).toBe("transaction");
    expect(envelopes[0].metrics).toEqual({ amount: 100000, tax: 10000, description: "売上A" });
  });

  it("B1: 金額合計がCSVと一致する", () => {
    const envelopes = parseCsvToEnvelopes(sampleCsv, fileFingerprint, companyId);
    const total = envelopes.reduce(
      (sum, e) => sum + (e.metrics.amount as number),
      0,
    );
    expect(total).toBe(50000); // 100000 + (-50000)
  });

  it("B2: 同一CSVの再投入で同じ event_id が生成される（冪等）", () => {
    const first = parseCsvToEnvelopes(sampleCsv, fileFingerprint, companyId);
    const second = parseCsvToEnvelopes(sampleCsv, fileFingerprint, companyId);
    expect(first.map((e) => e.event_id)).toEqual(second.map((e) => e.event_id));
  });

  it("B3: 修正済みCSVは変更行のみ新しいevent_idになる", () => {
    const modified = sampleCsv.replace("100000", "120000");
    const original = parseCsvToEnvelopes(sampleCsv, fileFingerprint, companyId);
    const updated = parseCsvToEnvelopes(modified, fileFingerprint, companyId);
    // 1行目のevent_idが変わり、2行目は同じ
    expect(updated[0].event_id).not.toBe(original[0].event_id);
    expect(updated[1].event_id).toBe(original[1].event_id);
  });

  it("event_id = hash(file_fingerprint, row_content)", () => {
    const id = generateEventId(fileFingerprint, "2026-06-01,売上A,100000,10000");
    expect(id).toMatch(/^[a-f0-9]{64}$/); // SHA-256
  });
});
