import { describe, it, expect } from "vitest";
import { renderAlert, type AlertEvent } from "../../src/act/alert-renderer";

describe("Immediate alert renderer (E3)", () => {
  const monitorDownEvent: AlertEvent = {
    event_id: "evt_monitor_001",
    event_type: "monitor",
    source: "monitor:health",
    metrics: { status: "down", url: "https://example.com" },
    occurred_at: new Date().toISOString(),
  };

  const deadlineEvent: AlertEvent = {
    event_id: "evt_deadline_001",
    event_type: "transaction",
    source: "deadline",
    metrics: {
      is_overdue: true,
      expected_date: "2026-07-01",
      url: "https://accounting.example.com/invoice/123",
    },
    occurred_at: new Date().toISOString(),
  };

  it("E3: alert body has no interpretation (facts + link only)", () => {
    const alert = renderAlert(monitorDownEvent);
    // No interpretation patterns
    expect(alert.body).not.toMatch(/考えられ|推測|可能性|おそらく|思われ/);
    // Contains factual URL
    expect(alert.body).toContain("https://example.com");
  });

  it("E3: deadline alert also has no interpretation", () => {
    const alert = renderAlert(deadlineEvent);
    expect(alert.body).not.toMatch(/考えられ|推測|可能性|おそらく|思われ/);
  });

  it("E3: immediate is only for monitor/deadline events", () => {
    const llmFinding: AlertEvent = {
      event_id: "evt_finding_001",
      event_type: "transaction",
      source: "investigator",
      metrics: {},
      occurred_at: new Date().toISOString(),
    };
    expect(() => renderAlert(llmFinding)).toThrow();
  });

  it("E3: alert includes event timestamp", () => {
    const alert = renderAlert(monitorDownEvent);
    expect(alert.body).toContain(monitorDownEvent.occurred_at);
  });

  it("E3: alert returns subject line", () => {
    const alert = renderAlert(monitorDownEvent);
    expect(alert.subject).toBeDefined();
    expect(alert.subject.length).toBeGreaterThan(0);
  });
});
