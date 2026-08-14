export interface FindingSummary {
  what: string;
  urgency: string;
  nextAction: string;
}

export interface CompanyState {
  baselineCount: number;
  coverageCount: number;
  stableSummary: string;
}

export interface WeeklySection {
  type: "digest" | "finding" | "followup" | "stable_coverage" | "nudge";
  content: string;
}

const MAX_FINDINGS = 2;

export function renderWeekly(findings: FindingSummary[], state: CompanyState): WeeklySection[] {
  const sections: WeeklySection[] = [];

  // 1. Digest
  const findingCount = Math.min(findings.length, MAX_FINDINGS);
  sections.push({
    type: "digest",
    content:
      findings.length > 0
        ? `${findingCount} finding(s) this week. ${state.coverageCount} indicators tracked.`
        : `All ${state.coverageCount} indicators stable this week.`,
  });

  // 2. Findings (max 2)
  const topFindings = findings.slice(0, MAX_FINDINGS);
  if (topFindings.length > 0) {
    sections.push({
      type: "finding",
      content: topFindings.map((f) => `- ${f.what}\n  Next: ${f.nextAction}`).join("\n"),
    });
  } else {
    sections.push({
      type: "finding",
      content: "",
    });
  }

  // 3. Followup
  sections.push({
    type: "followup",
    content: findings.length > 0 ? "Follow-up items from previous findings." : "",
  });

  // 4. Stable + Coverage
  sections.push({
    type: "stable_coverage",
    content: `${state.baselineCount} indicators normal. Coverage: ${state.coverageCount} indicators tracked.`,
  });

  // 5. Nudge (max 1 line)
  sections.push({
    type: "nudge",
    content:
      state.coverageCount < state.baselineCount
        ? `Connect more data sources to increase coverage.`
        : "",
  });

  return sections;
}
