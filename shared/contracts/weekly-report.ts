import { z } from "zod";

const WEEKLY_SECTIONS = ["digest", "finding", "followup", "stable_coverage", "nudge"] as const;

export const WeeklyReportSchema = z.object({
  company_id: z.string().uuid(),
  sections: z.array(
    z.object({
      type: z.enum(WEEKLY_SECTIONS),
      content: z.string(),
      finding_id: z.string().uuid().optional(), // for finding/followup sections
    }),
  ),
  period_start: z.string().datetime(),
  period_end: z.string().datetime(),
  generated_at: z.string().datetime(),
});

export type WeeklyReport = z.infer<typeof WeeklyReportSchema>;
