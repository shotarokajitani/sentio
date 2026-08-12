export interface Narrative {
  key: string;
  content: string;
  confidence: number;
  source_event_id: string;
  updated_at: string;
}

const HALF_LIFE_DAYS = 30;
const DECAY_LAMBDA = Math.LN2 / HALF_LIFE_DAYS;

export function createNarrative(
  key: string,
  content: string,
  sourceEventId: string,
): Narrative {
  return {
    key,
    content,
    confidence: 1.0,
    source_event_id: sourceEventId,
    updated_at: new Date().toISOString(),
  };
}

export function decayConfidence(narrative: Narrative, now: Date): number {
  const updatedAt = new Date(narrative.updated_at);
  const daysDiff = (now.getTime() - updatedAt.getTime()) / (24 * 60 * 60 * 1000);
  if (daysDiff <= 0) return narrative.confidence;
  return narrative.confidence * Math.exp(-DECAY_LAMBDA * daysDiff);
}

export function applyCorrection(
  narrative: Narrative,
  correctionContent: string,
  sourceEventId: string,
): Narrative {
  return {
    ...narrative,
    content: correctionContent,
    confidence: 0.0,
    source_event_id: sourceEventId,
    updated_at: new Date().toISOString(),
  };
}

export function upsertNarrative(
  existing: Narrative | null,
  key: string,
  content: string,
  sourceEventId: string,
): Narrative {
  if (existing === null) {
    return createNarrative(key, content, sourceEventId);
  }
  return {
    ...existing,
    content,
    confidence: 1.0,
    source_event_id: sourceEventId,
    updated_at: new Date().toISOString(),
  };
}
