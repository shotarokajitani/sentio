/// <reference types="node" />

/**
 * CLAUDE.md 絶対規則「S2テーブルに本文型カラムを追加しない」の機械的担保。
 *
 * 2026-08-19 まで、CLI 入口は `console.log` 1行で必ず exit 0 になっており、
 * 絶対規則の唯一の担保が空洞だった（契約 S-5-4）。実DBの
 * `information_schema.columns` を照会する形に直してある。
 */

import { pathToFileURL } from "node:url";
import { fetchPublicColumns } from "./live-schema";

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

export type AllowlistFailReason = "violations" | "no-columns" | "query-failed";

export interface AllowlistCheckResult {
  ok: boolean;
  columns: string[];
  violations: string[];
  reason?: AllowlistFailReason;
  error?: string;
}

/**
 * 照会関数を注入して判定する。
 * 「照会できなかった」を「違反なし」に丸めないことが要点で、
 * 例外も 0件も **緑にしない**（fail-closed）。
 */
export async function runAllowlistCheck(
  fetchColumns: () => Promise<string[]>,
): Promise<AllowlistCheckResult> {
  let columns: string[];
  try {
    columns = await fetchColumns();
  } catch (e) {
    return {
      ok: false,
      columns: [],
      violations: [],
      reason: "query-failed",
      error: (e as Error).message,
    };
  }

  if (columns.length === 0) {
    return { ok: false, columns, violations: [], reason: "no-columns" };
  }

  const { valid, violations } = validateS2Columns(columns, EVENTS_ALLOWLIST);
  return valid
    ? { ok: true, columns, violations: [] }
    : { ok: false, columns, violations, reason: "violations" };
}

/** 実DBから `public.events` の列名を取る。 */
export async function fetchEventsColumns(): Promise<string[]> {
  return fetchPublicColumns()
    .filter((r) => r.table === "events")
    .map((r) => r.column);
}

// `file://${process.argv[1]}` の連結は Windows で一致しない。pathToFileURL で正規化する。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runAllowlistCheck(fetchEventsColumns);

  if (result.ok) {
    console.log(`check:allowlist — events の実列 ${result.columns.length}件が allowlist と一致`);
    process.exit(0);
  }

  switch (result.reason) {
    case "query-failed":
      console.error(`check:allowlist — 実DBを照会できなかった: ${result.error}`);
      console.error("照会できないことを「違反なし」に丸めない（fail-closed）。");
      break;
    case "no-columns":
      console.error("check:allowlist — events の列が1件も取れなかった");
      console.error("テーブルが存在しないか、照会先が誤っている。空を緑にしない。");
      break;
    default:
      console.error(`check:allowlist — allowlist 違反 ${result.violations.length}件:`);
      for (const v of result.violations) console.error(`  events.${v}`);
      console.error("");
      console.error("S2テーブルに本文型カラムを追加しない（CLAUDE.md 絶対規則）。");
  }

  process.exit(1);
}
