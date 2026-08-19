/**
 * Seed synthetic company data into local Supabase for integration testing.
 * Usage: pnpm exec tsx scripts/seed-synthetic-local.ts
 */
import { generateSyntheticCompany } from "./generate-synthetic-company";
import { REVENUE_BASELINE } from "@edge/_shared/baseline-stats";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

async function main() {
  const company = generateSyntheticCompany();

  // Clean up existing synthetic data
  const deleteRes = await fetch(
    `${SUPABASE_URL}/rest/v1/events?company_id=eq.${company.meta.companyId}`,
    {
      method: "DELETE",
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        Prefer: "return=representation",
      },
    },
  );
  console.log(`Deleted existing events: ${deleteRes.status}`);

  // Also clean up null company_id events from synthetic data
  const deleteNullRes = await fetch(
    `${SUPABASE_URL}/rest/v1/events?company_id=is.null&event_id=like.ext_competitor*`,
    {
      method: "DELETE",
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        Prefer: "return=representation",
      },
    },
  );
  console.log(`Deleted null company events: ${deleteNullRes.status}`);

  // Clean up existing findings for synthetic company
  const deleteFindingsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/findings?company_id=eq.${company.meta.companyId}`,
    {
      method: "DELETE",
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        Prefer: "return=representation",
      },
    },
  );
  console.log(`Deleted existing findings: ${deleteFindingsRes.status}`);

  // Insert events in batches
  const batchSize = 20;
  let inserted = 0;
  for (let i = 0; i < company.events.length; i += batchSize) {
    const batch = company.events.slice(i, i + batchSize).map((e) => ({
      event_id: e.event_id,
      company_id: e.company_id,
      occurred_at: e.occurred_at,
      source: e.source,
      event_type: e.event_type,
      metrics: e.metrics,
      sensitivity: e.sensitivity,
    }));

    const res = await fetch(`${SUPABASE_URL}/rest/v1/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(batch),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`Batch ${i / batchSize} failed: ${res.status} ${body}`);
    } else {
      inserted += batch.length;
    }
  }

  console.log(`Inserted ${inserted} events for ${company.meta.name}`);
  console.log(`Company ID: ${company.meta.companyId}`);
  console.log(
    `Planted signals: ${company.plantedSignals.length} (${company.plantedSignals.filter((s) => s.type === "positive").length} positive, ${company.plantedSignals.filter((s) => s.type === "negative").length} negative)`,
  );

  // Upsert baselines for synthetic company
  //
  // **統計は `stats` JSONB に入れる**（契約 S-1-4）。修復前はここが
  // median / iqr / p25 / p75 / observation_count を「列として」書き、
  // かつ `stats: {}` を並べていた。実在しない列なので投入は失敗し、
  // 仮に通っても `stats` が空なので読み側からは基準値なしに見える。
  //
  // `entity_id` は自然キー (company_id, metric_key, entity_id, granularity) の
  // 一部なので明示する。会社全体の指標なので null
  const baselines = [
    {
      company_id: company.meta.companyId,
      metric_key: REVENUE_BASELINE.metricKey,
      entity_id: REVENUE_BASELINE.entityId,
      granularity: REVENUE_BASELINE.granularity,
      is_established: true,
      stats: { median: 100000, iqr: 15000, p25: 93000, p75: 108000, count: 12 },
      min_obs: 5,
      updated_at: new Date().toISOString(),
    },
    {
      company_id: company.meta.companyId,
      metric_key: "schedule_interval",
      entity_id: null,
      granularity: "weekly",
      is_established: true,
      stats: { median: 7, iqr: 2, p25: 6, p75: 8, count: 8 },
      min_obs: 5,
      updated_at: new Date().toISOString(),
    },
  ];

  for (const bl of baselines) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/baselines`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        Prefer: "return=minimal,resolution=merge-duplicates",
      },
      body: JSON.stringify(bl),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`Baseline ${bl.metric_key} failed: ${res.status} ${body}`);
    }
  }
  console.log(`Upserted ${baselines.length} baselines`);
}

main().catch(console.error);
