export interface CalendarDraft {
  id: string;
  findingId: string;
  recipientId: string;
  status: "draft" | "confirmed";
  sentAt: string | null;
  registeredAt: string | null;
  createdAt: string;
}

export function createCalendarDraft(
  findingId: string,
  recipientId: string,
): CalendarDraft {
  return {
    id: crypto.randomUUID(),
    findingId,
    recipientId,
    status: "draft",
    sentAt: null,
    registeredAt: null,
    createdAt: new Date().toISOString(),
  };
}

export function confirmDraft(draft: CalendarDraft): CalendarDraft {
  if (draft.status === "confirmed") {
    throw new Error("Draft is already confirmed");
  }
  return {
    ...draft,
    status: "confirmed",
    registeredAt: new Date().toISOString(),
  };
}
