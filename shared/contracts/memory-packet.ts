import { z } from "zod";

export const MemoryPacketSchema = z.object({
  company_id: z.string().uuid(),
  sections: z.array(
    z.object({
      type: z.enum(["summary", "baselines", "recent_events", "findings", "narratives"]),
      content: z.string(),
      tokens: z.number().int(),
      priority: z.number().int(), // lower = higher priority
    }),
  ),
  totalTokens: z.number().int(),
  budgetTokens: z.number().int(),
  assembled_at: z.string().datetime(),
});

export type MemoryPacket = z.infer<typeof MemoryPacketSchema>;
