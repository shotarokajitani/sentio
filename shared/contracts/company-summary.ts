import { z } from "zod";

export const CompanySummarySchema = z.object({
  company_id: z.string().uuid(),
  content: z.string(),
  token_count: z.number().int().positive(),
  chapters: z.array(
    z.object({
      key: z.string(),
      title: z.string(),
      content: z.string(),
    }),
  ),
  generated_at: z.string().datetime(),
});

export type CompanySummary = z.infer<typeof CompanySummarySchema>;
