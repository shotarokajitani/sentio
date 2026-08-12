import { describe, it, expect } from "vitest";
import { shouldDeliverNow, type DeliveryInput } from "../../src/act/quiet-hours";

describe("Quiet hours (E5)", () => {
  it("23:00-6:00 non-exception alerts are deferred to next morning", () => {
    const input: DeliveryInput = {
      urgency: "immediate",
      category: "ssl_expiry",
    };
    const result = shouldDeliverNow(
      input,
      new Date("2026-07-01T23:30:00+09:00"),
    );
    expect(result.deliver).toBe(false);
    expect(result.deferUntil).toBeDefined();
    // Should defer to 6:00 AM next day JST
    expect(result.deferUntil!.toISOString()).toBe(
      new Date("2026-07-02T06:00:00+09:00").toISOString(),
    );
  });

  it("site_down is delivered even during quiet hours (ongoing loss exception)", () => {
    const input: DeliveryInput = {
      urgency: "immediate",
      category: "site_down",
    };
    const result = shouldDeliverNow(
      input,
      new Date("2026-07-01T02:00:00+09:00"),
    );
    expect(result.deliver).toBe(true);
  });

  it("after 6:00 delivers normally", () => {
    const input: DeliveryInput = {
      urgency: "immediate",
      category: "ssl_expiry",
    };
    const result = shouldDeliverNow(
      input,
      new Date("2026-07-01T06:01:00+09:00"),
    );
    expect(result.deliver).toBe(true);
  });

  it("before 23:00 delivers normally", () => {
    const input: DeliveryInput = {
      urgency: "immediate",
      category: "payment_overdue",
    };
    const result = shouldDeliverNow(
      input,
      new Date("2026-07-01T22:59:00+09:00"),
    );
    expect(result.deliver).toBe(true);
  });

  it("weekly urgency always delivers (not subject to quiet hours)", () => {
    const input: DeliveryInput = {
      urgency: "weekly",
      category: "finding",
    };
    const result = shouldDeliverNow(
      input,
      new Date("2026-07-01T03:00:00+09:00"),
    );
    expect(result.deliver).toBe(true);
  });

  it("midnight exactly is in quiet hours", () => {
    const input: DeliveryInput = {
      urgency: "immediate",
      category: "ssl_expiry",
    };
    const result = shouldDeliverNow(
      input,
      new Date("2026-07-02T00:00:00+09:00"),
    );
    expect(result.deliver).toBe(false);
  });
});
