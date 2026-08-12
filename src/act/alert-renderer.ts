export interface AlertEvent {
  event_id: string;
  event_type: string;
  source: string;
  metrics: Record<string, unknown>;
  occurred_at: string;
}

export interface AlertOutput {
  subject: string;
  body: string;
}

const IMMEDIATE_SOURCES = ["monitor:health", "monitor:ssl", "monitor:speed", "deadline"];

export function renderAlert(event: AlertEvent): AlertOutput {
  // E3: immediate is only for monitor/deadline events
  const isMonitor = event.event_type === "monitor" || event.source.startsWith("monitor:");
  const isDeadline = event.source === "deadline" || event.metrics.is_overdue === true;

  if (!isMonitor && !isDeadline) {
    throw new Error(
      `Immediate alerts are restricted to monitor/deadline events. Got: ${event.event_type}/${event.source}`,
    );
  }

  // Build factual-only alert (no interpretation)
  if (isMonitor) {
    const status = event.metrics.status as string;
    const url = event.metrics.url as string;
    return {
      subject: `[Alert] ${status === "down" ? "Site Down" : "Monitor Alert"}: ${url || "unknown"}`,
      body: `Status: ${status}\nURL: ${url}\nDetected: ${event.occurred_at}`,
    };
  }

  // Deadline alert
  const expectedDate = event.metrics.expected_date as string;
  const url = event.metrics.url as string | undefined;
  return {
    subject: `[Alert] Overdue: ${expectedDate}`,
    body: `Expected date: ${expectedDate}\nStatus: overdue${url ? `\nDetails: ${url}` : ""}\nDetected: ${event.occurred_at}`,
  };
}
