import { describe, it, expect } from "vitest";
import { FindingSchema, parseFinding } from "@shared/contracts/finding";
import { CompanySummarySchema } from "@shared/contracts/company-summary";
import { MemoryPacketSchema } from "@shared/contracts/memory-packet";
import { Day0ReportSchema } from "@shared/contracts/day0-report";
import { WeeklyReportSchema } from "@shared/contracts/weekly-report";

const COMPANY_ID = "550e8400-e29b-41d4-a716-446655440000";
const UUID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

// ── Finding ──────────────────────────────────────────────

describe("FindingSchema", () => {
  const validFinding = {
    id: UUID,
    company_id: COMPANY_ID,
    status: "open",
    urgency: "weekly",
    what: "売上が前月比30%減少",
    evidence_event_ids: ["evt_001", "evt_002"],
    confidence: 0.85,
    hypotheses: [
      { text: "季節要因", plausibility: "high" },
      { text: "競合の影響", plausibility: "medium" },
      { text: "価格改定の反動", plausibility: "low" },
    ],
    next_actions: [
      { description: "過去の同月比較を確認", onetap_type: "watch" as const },
      { description: "営業担当にヒアリング" },
    ],
    eval_log: {
      criteria: [
        { name: "novelty", pass: true, reason: "新規パターン" },
        { name: "so_what", pass: true, reason: "経営判断に影響" },
        { name: "evidence", pass: true, reason: "証拠十分" },
        { name: "clarity", pass: true, reason: "明確" },
        { name: "actionability", pass: true, reason: "アクション可能" },
      ],
      revisions: 1,
      result: "pass" as const,
    },
    parent_finding_id: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
  };

  it("有効なFindingをパースできる", () => {
    const result = FindingSchema.safeParse(validFinding);
    expect(result.success).toBe(true);
  });

  it("parseFinding ヘルパーも動作する", () => {
    const result = parseFinding(validFinding);
    expect(result.success).toBe(true);
  });

  it("hypotheses が3件未満ならエラー（Senseルール）", () => {
    const result = FindingSchema.safeParse({
      ...validFinding,
      hypotheses: [
        { text: "A", plausibility: "high" },
        { text: "B", plausibility: "low" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("evidence_event_ids が空ならエラー（D5）", () => {
    const result = FindingSchema.safeParse({
      ...validFinding,
      evidence_event_ids: [],
    });
    expect(result.success).toBe(false);
  });

  it("eval_log.criteria が5件でなければエラー（D3）", () => {
    const result = FindingSchema.safeParse({
      ...validFinding,
      eval_log: {
        ...validFinding.eval_log,
        criteria: validFinding.eval_log.criteria.slice(0, 4),
      },
    });
    expect(result.success).toBe(false);
  });

  it("eval_log.revisions が3以上ならエラー（D3 上限2）", () => {
    const result = FindingSchema.safeParse({
      ...validFinding,
      eval_log: { ...validFinding.eval_log, revisions: 3 },
    });
    expect(result.success).toBe(false);
  });

  it("what が空文字ならエラー", () => {
    const result = FindingSchema.safeParse({
      ...validFinding,
      what: "",
    });
    expect(result.success).toBe(false);
  });

  it("confidence が0〜1の範囲外ならエラー", () => {
    const over = FindingSchema.safeParse({ ...validFinding, confidence: 1.5 });
    const under = FindingSchema.safeParse({ ...validFinding, confidence: -0.1 });
    expect(over.success).toBe(false);
    expect(under.success).toBe(false);
  });
});

// ── CompanySummary ───────────────────────────────────────

describe("CompanySummarySchema", () => {
  const validSummary = {
    company_id: COMPANY_ID,
    content: "株式会社テストの概要...",
    token_count: 1500,
    chapters: [
      { key: "overview", title: "概要", content: "会社概要テキスト" },
      { key: "financials", title: "財務", content: "財務データ" },
    ],
    generated_at: "2026-07-01T00:00:00Z",
  };

  it("有効なCompanySummaryをパースできる", () => {
    const result = CompanySummarySchema.safeParse(validSummary);
    expect(result.success).toBe(true);
  });

  it("chaptersが存在しパースされる", () => {
    const result = CompanySummarySchema.safeParse(validSummary);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.chapters).toHaveLength(2);
      expect(result.data.chapters[0].key).toBe("overview");
    }
  });

  it("token_count が正の整数でなければエラー", () => {
    const zero = CompanySummarySchema.safeParse({ ...validSummary, token_count: 0 });
    const negative = CompanySummarySchema.safeParse({ ...validSummary, token_count: -1 });
    expect(zero.success).toBe(false);
    expect(negative.success).toBe(false);
  });
});

// ── MemoryPacket ─────────────────────────────────────────

describe("MemoryPacketSchema", () => {
  const validPacket = {
    company_id: COMPANY_ID,
    sections: [
      { type: "summary", content: "概要", tokens: 500, priority: 1 },
      { type: "baselines", content: "基準値", tokens: 300, priority: 2 },
      { type: "recent_events", content: "最近のイベント", tokens: 400, priority: 3 },
      { type: "findings", content: "発見事項", tokens: 200, priority: 4 },
      { type: "narratives", content: "ナラティブ", tokens: 100, priority: 5 },
    ],
    totalTokens: 1500,
    budgetTokens: 2000,
    assembled_at: "2026-07-01T00:00:00Z",
  };

  it("有効なMemoryPacketをパースできる", () => {
    const result = MemoryPacketSchema.safeParse(validPacket);
    expect(result.success).toBe(true);
  });

  it("totalTokens がbudgetTokens以内であることを確認できる", () => {
    const result = MemoryPacketSchema.safeParse(validPacket);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.totalTokens).toBeLessThanOrEqual(result.data.budgetTokens);
    }
  });

  it("section type が無効ならエラー", () => {
    const result = MemoryPacketSchema.safeParse({
      ...validPacket,
      sections: [{ type: "invalid", content: "x", tokens: 100, priority: 1 }],
    });
    expect(result.success).toBe(false);
  });
});

// ── Day0Report ───────────────────────────────────────────

describe("Day0ReportSchema", () => {
  const DAY0_KEYS = [
    "external_view",
    "reputation",
    "site_health",
    "public_records",
    "opportunities",
    "industry_position",
    "initial_hypothesis",
    "coverage_map",
  ] as const;

  const validDay0 = {
    company_id: COMPANY_ID,
    blocks: DAY0_KEYS.map((key) => ({
      key,
      title: `${key} title`,
      content: `${key} content`,
      hasData: true,
      sources: ["google", "corporate_site"],
    })),
    generated_at: "2026-07-01T00:00:00Z",
    generation_time_ms: 12345,
  };

  it("有効なDay0Reportをパースできる", () => {
    const result = Day0ReportSchema.safeParse(validDay0);
    expect(result.success).toBe(true);
  });

  it("8つのブロックキーが全て有効な値である", () => {
    const result = Day0ReportSchema.safeParse(validDay0);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.blocks).toHaveLength(8);
    }
  });

  it("無効なブロックキーはエラー", () => {
    const result = Day0ReportSchema.safeParse({
      ...validDay0,
      blocks: [{ key: "invalid_block", title: "x", content: "x", hasData: true, sources: [] }],
    });
    expect(result.success).toBe(false);
  });
});

// ── WeeklyReport ─────────────────────────────────────────

describe("WeeklyReportSchema", () => {
  const validWeekly = {
    company_id: COMPANY_ID,
    sections: [
      { type: "digest", content: "今週のダイジェスト" },
      { type: "finding", content: "発見事項", finding_id: UUID },
      { type: "followup", content: "フォローアップ", finding_id: UUID },
      { type: "stable_coverage", content: "安定指標" },
      { type: "nudge", content: "ナッジ" },
    ],
    period_start: "2026-06-23T00:00:00Z",
    period_end: "2026-06-30T00:00:00Z",
    generated_at: "2026-07-01T00:00:00Z",
  };

  it("有効なWeeklyReportをパースできる", () => {
    const result = WeeklyReportSchema.safeParse(validWeekly);
    expect(result.success).toBe(true);
  });

  it("section type が有効なenumに含まれる", () => {
    const result = WeeklyReportSchema.safeParse(validWeekly);
    expect(result.success).toBe(true);
    if (result.success) {
      const types = result.data.sections.map((s) => s.type);
      expect(types).toEqual(["digest", "finding", "followup", "stable_coverage", "nudge"]);
    }
  });

  it("無効なsection typeはエラー", () => {
    const result = WeeklyReportSchema.safeParse({
      ...validWeekly,
      sections: [{ type: "invalid_section", content: "x" }],
    });
    expect(result.success).toBe(false);
  });
});
