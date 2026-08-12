import { describe, it, expect } from "vitest";
import {
  assemblePacket,
  estimateTokens,
  type SectionInput,
} from "../../src/state/memory-packet";
import { MemoryPacketSchema } from "../../shared/contracts/memory-packet";

describe("Memory packet assembler (C3)", () => {
  const companyId = "550e8400-e29b-41d4-a716-446655440000";

  const makeSections = (): SectionInput[] => [
    { type: "summary", content: "Company overview text here", priority: 1 },
    { type: "baselines", content: "Baseline metrics for revenue, orders", priority: 2 },
    { type: "recent_events", content: "Recent transaction and schedule events", priority: 3 },
    { type: "findings", content: "Open finding: revenue drop detected", priority: 4 },
    { type: "narratives", content: "Owner mentioned concern about cash flow", priority: 5 },
  ];

  it("C3: total tokens within budget", () => {
    const packet = assemblePacket(makeSections(), {
      companyId,
      tokenBudget: 4000,
    });
    expect(packet.totalTokens).toBeLessThanOrEqual(4000);
  });

  it("C3: when over budget, lower-priority sections are truncated first", () => {
    // Create sections where total exceeds budget
    const sections: SectionInput[] = [
      { type: "summary", content: "A".repeat(400), priority: 1 },
      { type: "baselines", content: "B".repeat(400), priority: 2 },
      { type: "recent_events", content: "C".repeat(400), priority: 3 },
      { type: "findings", content: "D".repeat(400), priority: 4 },
      { type: "narratives", content: "E".repeat(400), priority: 5 },
    ];
    // Budget allows ~3 sections (300 tokens = 1200 chars)
    const packet = assemblePacket(sections, { companyId, tokenBudget: 300 });
    expect(packet.totalTokens).toBeLessThanOrEqual(300);
    // Higher priority sections should be present
    const types = packet.sections.map((s) => s.type);
    expect(types[0]).toBe("summary");
  });

  it("C3: summary section is ALWAYS included even at very low budget", () => {
    const sections: SectionInput[] = [
      { type: "summary", content: "Important summary", priority: 1 },
      { type: "baselines", content: "B".repeat(2000), priority: 2 },
    ];
    const packet = assemblePacket(sections, { companyId, tokenBudget: 10 });
    expect(packet.sections.some((s) => s.type === "summary")).toBe(true);
  });

  it("C3: sections are ordered by priority", () => {
    const sections: SectionInput[] = [
      { type: "narratives", content: "Narratives", priority: 5 },
      { type: "summary", content: "Summary", priority: 1 },
      { type: "findings", content: "Findings", priority: 4 },
      { type: "baselines", content: "Baselines", priority: 2 },
    ];
    const packet = assemblePacket(sections, { companyId, tokenBudget: 4000 });
    for (let i = 1; i < packet.sections.length; i++) {
      expect(packet.sections[i].priority).toBeGreaterThanOrEqual(
        packet.sections[i - 1].priority,
      );
    }
  });

  it("C3: output conforms to MemoryPacketSchema", () => {
    const packet = assemblePacket(makeSections(), {
      companyId,
      tokenBudget: 4000,
    });
    const result = MemoryPacketSchema.safeParse(packet);
    expect(result.success).toBe(true);
  });

  it("estimateTokens approximation", () => {
    // ~4 chars per token
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(100))).toBe(25);
    expect(estimateTokens("")).toBe(0);
  });
});
