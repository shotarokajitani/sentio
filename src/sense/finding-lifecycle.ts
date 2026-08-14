export interface FindingRecord {
  id: string;
  company_id: string;
  status: "open" | "watching" | "resolved" | "expired";
  urgency: "immediate" | "weekly" | "monthly";
  what: string;
  evidence_event_ids: string[];
  confidence: number;
  hypotheses: Array<{
    text: string;
    plausibility: "high" | "medium" | "low";
  }>;
  parent_finding_id: string | null;
  created_at: string;
  updated_at: string;
}

export function createFinding(params: {
  company_id: string;
  what: string;
  evidence_event_ids: string[];
  hypotheses: Array<{ text: string; plausibility: "high" | "medium" | "low" }>;
  urgency: "immediate" | "weekly" | "monthly";
  confidence: number;
}): FindingRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    company_id: params.company_id,
    status: "open",
    urgency: params.urgency,
    what: params.what,
    evidence_event_ids: params.evidence_event_ids,
    confidence: params.confidence,
    hypotheses: params.hypotheses,
    parent_finding_id: null,
    created_at: now,
    updated_at: now,
  };
}

export function handleRedetection(
  existing: FindingRecord,
  newEvidenceIds: string[],
): FindingRecord {
  // Merge evidence, deduplicating
  const allEvidence = [...new Set([...existing.evidence_event_ids, ...newEvidenceIds])];

  return {
    ...existing,
    status: "open",
    evidence_event_ids: allEvidence,
    updated_at: new Date().toISOString(),
  };
}

export function transitionStatus(
  finding: FindingRecord,
  newStatus: "open" | "watching" | "resolved" | "expired",
): FindingRecord {
  return {
    ...finding,
    status: newStatus,
    updated_at: new Date().toISOString(),
  };
}
