import type { MemoryPacket } from "../../shared/contracts/memory-packet";

export type SectionType = "summary" | "baselines" | "recent_events" | "findings" | "narratives";

export interface SectionInput {
  type: SectionType;
  content: string;
  priority: number;
}

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function assemblePacket(
  sections: SectionInput[],
  options: { companyId: string; tokenBudget: number },
): MemoryPacket {
  // Sort by priority (ascending = highest priority first)
  const sorted = [...sections].sort((a, b) => a.priority - b.priority);

  const assembled: Array<{
    type: SectionType;
    content: string;
    tokens: number;
    priority: number;
  }> = [];
  let totalTokens = 0;

  for (const section of sorted) {
    const sectionTokens = estimateTokens(section.content);

    // Summary is always included regardless of budget
    if (section.type === "summary") {
      assembled.push({
        type: section.type,
        content: section.content,
        tokens: sectionTokens,
        priority: section.priority,
      });
      totalTokens += sectionTokens;
      continue;
    }

    const remaining = options.tokenBudget - totalTokens;
    if (remaining <= 0) break;

    if (sectionTokens <= remaining) {
      assembled.push({
        type: section.type,
        content: section.content,
        tokens: sectionTokens,
        priority: section.priority,
      });
      totalTokens += sectionTokens;
    } else {
      // Truncate to fit remaining budget
      const allowedChars = remaining * 4;
      const truncated = section.content.slice(0, allowedChars);
      const truncTokens = estimateTokens(truncated);
      assembled.push({
        type: section.type,
        content: truncated,
        tokens: truncTokens,
        priority: section.priority,
      });
      totalTokens += truncTokens;
      break;
    }
  }

  return {
    company_id: options.companyId,
    sections: assembled,
    totalTokens,
    budgetTokens: options.tokenBudget,
    assembled_at: new Date().toISOString(),
  };
}
