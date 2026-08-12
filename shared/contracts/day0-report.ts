import { z } from "zod";

const DAY0_BLOCKS = [
  "external_view",
  "reputation",
  "site_health",
  "public_records",
  "opportunities",
  "industry_position",
  "initial_hypothesis",
  "coverage_map",
] as const;

export const Day0ReportSchema = z.object({
  company_id: z.string().uuid(),
  blocks: z.array(
    z.object({
      key: z.enum(DAY0_BLOCKS),
      title: z.string(),
      content: z.string(),
      hasData: z.boolean(),
      sources: z.array(z.string()), // 出所表記
    }),
  ),
  generated_at: z.string().datetime(),
  generation_time_ms: z.number().int(),
});

export type Day0Report = z.infer<typeof Day0ReportSchema>;
