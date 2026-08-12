import { z } from "zod";

export const FindingSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  status: z.enum(["open", "watching", "resolved", "expired"]),
  urgency: z.enum(["immediate", "weekly", "monthly"]),
  what: z.string().min(1), // 何が変わったか
  evidence_event_ids: z.array(z.string()).min(1), // D5: 証拠リンク必須 (min 1)
  confidence: z.number().min(0).max(1),
  hypotheses: z
    .array(
      z.object({
        text: z.string(),
        plausibility: z.enum(["high", "medium", "low"]),
      }),
    )
    .min(3), // Sense rule: 仮説3件未満のFinding禁止
  next_actions: z.array(
    z.object({
      description: z.string(),
      onetap_type: z
        .enum(["calendar", "message_draft", "employee_check", "watch"])
        .optional(),
    }),
  ),
  eval_log: z.object({
    criteria: z
      .array(
        z.object({
          name: z.string(),
          pass: z.boolean(),
          reason: z.string(),
        }),
      )
      .length(5), // D3: Evaluator 5基準
    revisions: z.number().min(0).max(2), // D3: revise上限2
    result: z.enum(["pass", "revise", "reject"]),
  }),
  parent_finding_id: z.string().uuid().nullable().default(null),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type Finding = z.infer<typeof FindingSchema>;
export const parseFinding = (data: unknown) => FindingSchema.safeParse(data);
