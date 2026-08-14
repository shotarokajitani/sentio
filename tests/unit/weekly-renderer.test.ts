import { describe, it, expect } from "vitest";
import {
  renderWeekly,
  type WeeklySection,
  type CompanyState,
  type FindingSummary,
} from "../../src/act/weekly-renderer";

function makeCompanyState(overrides: Partial<CompanyState> = {}): CompanyState {
  return {
    baselineCount: 32,
    coverageCount: 28,
    stableSummary: "32 indicators normal this month, +3 new indicators",
    ...overrides,
  };
}

function makeFinding(overrides: Partial<FindingSummary> = {}): FindingSummary {
  return {
    what: "Revenue dropped 30% compared to baseline",
    urgency: "weekly",
    nextAction: "Check with accounting",
    ...overrides,
  };
}

describe("Weekly email renderer (E1-E2)", () => {
  it("E1: section order matches spec", () => {
    const sections = renderWeekly([makeFinding()], makeCompanyState());
    const order = sections.map((s) => s.type);
    expect(order).toEqual(["digest", "finding", "followup", "stable_coverage", "nudge"]);
  });

  it("E1: Finding is 0-2 items", () => {
    const manyFindings = [makeFinding(), makeFinding(), makeFinding()];
    const sections = renderWeekly(manyFindings, makeCompanyState());
    const findingSections = sections.filter((s) => s.type === "finding");
    expect(findingSections.length).toBeLessThanOrEqual(2);
  });

  it("E1: nudge is max 1 line", () => {
    const sections = renderWeekly([makeFinding()], makeCompanyState());
    const nudge = sections.find((s) => s.type === "nudge");
    if (nudge && nudge.content.trim().length > 0) {
      expect(nudge.content.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(1);
    }
  });

  it("E2: zero-finding week shows stable + coverage count", () => {
    const sections = renderWeekly([], makeCompanyState());
    const stable = sections.find((s) => s.type === "stable_coverage");
    expect(stable).toBeDefined();
    expect(stable!.content).toContain("indicator");
    expect(stable!.content).toMatch(/\d+/);
  });

  it("E1: digest section always present", () => {
    const sections = renderWeekly([], makeCompanyState());
    const digest = sections.find((s) => s.type === "digest");
    expect(digest).toBeDefined();
    expect(digest!.content.length).toBeGreaterThan(0);
  });
});
