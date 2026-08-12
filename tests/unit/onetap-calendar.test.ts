import { describe, it, expect } from "vitest";
import {
  createCalendarDraft,
  confirmDraft,
  type CalendarDraft,
} from "../../src/act/onetap-calendar";

describe("One-tap calendar (E4)", () => {
  it("E4: draft is generated with status=draft, nothing sent or registered", () => {
    const draft = createCalendarDraft("finding_001", "recipient_001");
    expect(draft.status).toBe("draft");
    expect(draft.sentAt).toBeNull();
    expect(draft.registeredAt).toBeNull();
  });

  it("E4: draft contains finding reference", () => {
    const draft = createCalendarDraft("finding_001", "recipient_001");
    expect(draft.findingId).toBe("finding_001");
    expect(draft.recipientId).toBe("recipient_001");
  });

  it("E4: confirm sets status to confirmed with timestamp", () => {
    const draft = createCalendarDraft("finding_001", "recipient_001");
    const confirmed = confirmDraft(draft);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.registeredAt).not.toBeNull();
  });

  it("E4: cannot confirm an already confirmed draft", () => {
    const draft = createCalendarDraft("finding_001", "recipient_001");
    const confirmed = confirmDraft(draft);
    expect(() => confirmDraft(confirmed)).toThrow();
  });

  it("E4: draft has unique id", () => {
    const d1 = createCalendarDraft("f1", "r1");
    const d2 = createCalendarDraft("f2", "r2");
    expect(d1.id).not.toBe(d2.id);
  });
});
