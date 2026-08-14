/// <reference types="node" />

export const EVENTS_ALLOWLIST = [
  "event_id",
  "company_id",
  "occurred_at",
  "period_start",
  "period_end",
  "ingested_at",
  "source",
  "event_type",
  "actor_ref",
  "entity_refs",
  "metrics",
  "sensitivity",
] as const;

const TOKEN_PATTERNS = /token|secret|password|credential|api_key/i;

export function validateS2Columns(
  actualColumns: readonly string[],
  allowlist: readonly string[],
): { valid: boolean; violations: string[] } {
  const allowSet = new Set<string>(allowlist);
  const violations = actualColumns.filter((col) => !allowSet.has(col) || TOKEN_PATTERNS.test(col));
  return { valid: violations.length === 0, violations };
}

// CLI実行時
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("check:allowlist — run against live DB");
}
