import type { CompanySummary } from "../../shared/contracts/company-summary";

export const MAX_SUMMARY_TOKENS = 4000;

export const CHAPTER_KEYS = [
  "overview",
  "financial",
  "operations",
  "people",
  "external",
] as const;

const CHAPTER_TITLES: Record<(typeof CHAPTER_KEYS)[number], string> = {
  overview: "Overview",
  financial: "Financial",
  operations: "Operations",
  people: "People",
  external: "External",
};

export interface CompanyData {
  companyId: string;
  overview: string;
  financial: string;
  operations: string;
  people: string;
  external: string;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function generateSummary(data: CompanyData): CompanySummary {
  const chapters = CHAPTER_KEYS.map((key) => ({
    key,
    title: CHAPTER_TITLES[key],
    content: data[key] || "(no data)",
  }));

  // Calculate total tokens and truncate if needed
  let totalTokens = chapters.reduce((sum, ch) => sum + estimateTokens(ch.content), 0);

  if (totalTokens > MAX_SUMMARY_TOKENS) {
    // Truncate from last chapter backwards (lower priority)
    for (let i = chapters.length - 1; i >= 0 && totalTokens > MAX_SUMMARY_TOKENS; i--) {
      const chTokens = estimateTokens(chapters[i].content);
      const excess = totalTokens - MAX_SUMMARY_TOKENS;
      if (chTokens > excess) {
        // Truncate this chapter partially
        const allowedChars = (chTokens - excess) * 4;
        chapters[i].content = chapters[i].content.slice(0, Math.max(1, allowedChars));
        totalTokens = MAX_SUMMARY_TOKENS;
      } else {
        // Remove this chapter's content entirely
        chapters[i].content = "(truncated)";
        totalTokens -= chTokens - estimateTokens("(truncated)");
      }
    }
    totalTokens = chapters.reduce((sum, ch) => sum + estimateTokens(ch.content), 0);
  }

  const content = chapters.map((ch) => `## ${ch.title}\n${ch.content}`).join("\n\n");

  return {
    company_id: data.companyId,
    content,
    token_count: totalTokens,
    chapters,
    generated_at: new Date().toISOString(),
  };
}
