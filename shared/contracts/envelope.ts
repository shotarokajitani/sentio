import { z } from "zod";

const EVENT_TYPES = [
  "transaction",
  "communication",
  "schedule",
  "attendance",
  "web",
  "external",
  "monitor",
  "dialogue",
] as const;

const SENSITIVITIES = ["S0", "S1", "S2", "S3"] as const;

export const EventEnvelope = z
  .object({
    event_id: z.string().min(1),
    company_id: z.string().uuid().nullable(),
    occurred_at: z.string().datetime(),
    period_start: z.string().datetime().optional(),
    period_end: z.string().datetime().optional(),
    ingested_at: z.string().datetime(),
    source: z.string().min(1),
    event_type: z.enum(EVENT_TYPES),
    actor_ref: z.string().uuid().optional(),
    entity_refs: z.array(z.string().uuid()).default([]),
    metrics: z.record(z.string(), z.unknown()).default({}),
    sensitivity: z.enum(SENSITIVITIES),
  })
  .refine((e) => e.sensitivity === "S0" || e.company_id !== null, {
    message: "S1以上は company_id 必須",
  });

export type EventEnvelopeType = z.infer<typeof EventEnvelope>;
export const parseEnvelope = (data: unknown) => EventEnvelope.safeParse(data);
