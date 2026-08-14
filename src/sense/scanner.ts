export interface TimelineEvent {
  event_id: string;
  company_id: string | null;
  occurred_at: string;
  source: string;
  event_type: string;
  metrics: Record<string, unknown>;
  sensitivity: string;
}

export interface Baseline {
  metric_key: string;
  is_established: boolean;
  median: number;
  iqr: number;
  p25: number;
  p75: number;
  count: number;
}

export interface ScanCandidate {
  scanType: "deviation" | "trend" | "silence" | "deadline" | "external";
  source: string;
  suggestedUrgency: "immediate" | "weekly" | "monthly";
  evidence_event_ids: string[];
  description: string;
  score: number;
}

const TREND_MIN_PERIODS = 4;
const SILENCE_MULTIPLIER = 3; // alert if gap > median * multiplier

export function runScan(events: TimelineEvent[], baselines: Baseline[]): ScanCandidate[] {
  const candidates: ScanCandidate[] = [];

  candidates.push(...scanDeviation(events, baselines));
  candidates.push(...scanTrend(events, baselines));
  candidates.push(...scanSilence(events, baselines));
  candidates.push(...scanMetricChange(events));
  candidates.push(...scanDeadline(events));
  candidates.push(...scanExternal(events));
  candidates.push(...scanMonitor(events));

  return candidates;
}

function scanDeviation(events: TimelineEvent[], baselines: Baseline[]): ScanCandidate[] {
  const candidates: ScanCandidate[] = [];
  const established = baselines.filter((b) => b.is_established);

  for (const event of events) {
    if (event.event_type !== "transaction") continue;
    const revenue = event.metrics.revenue as number | undefined;
    if (revenue === undefined) continue;

    for (const bl of established) {
      if (bl.metric_key !== "revenue") continue;
      // Deviation = value outside [p25 - 1.5*IQR, p75 + 1.5*IQR]
      const lowerBound = bl.p25 - 1.5 * bl.iqr;
      const upperBound = bl.p75 + 1.5 * bl.iqr;
      if (revenue < lowerBound || revenue > upperBound) {
        candidates.push({
          scanType: "deviation",
          source: "transaction",
          suggestedUrgency: "weekly",
          evidence_event_ids: [event.event_id],
          description: `Revenue ${revenue} outside range [${lowerBound}, ${upperBound}]`,
          score: Math.abs(revenue - bl.median) / bl.iqr,
        });
      }
    }
  }

  return candidates;
}

function scanTrend(events: TimelineEvent[], baselines: Baseline[]): ScanCandidate[] {
  const candidates: ScanCandidate[] = [];
  const established = baselines.filter((b) => b.is_established);
  if (established.length === 0) return candidates;

  // Sort events by time
  const txnEvents = events
    .filter((e) => e.event_type === "transaction" && e.metrics.revenue !== undefined)
    .sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());

  if (txnEvents.length < TREND_MIN_PERIODS) return candidates;

  // Check for consecutive same-direction movement
  let consecutiveDown = 0;
  let consecutiveUp = 0;
  const trendIds: string[] = [];

  for (let i = 1; i < txnEvents.length; i++) {
    const prev = txnEvents[i - 1].metrics.revenue as number;
    const curr = txnEvents[i].metrics.revenue as number;

    if (curr < prev) {
      consecutiveDown++;
      consecutiveUp = 0;
      trendIds.push(txnEvents[i].event_id);
    } else if (curr > prev) {
      consecutiveUp++;
      consecutiveDown = 0;
      trendIds.push(txnEvents[i].event_id);
    } else {
      consecutiveDown = 0;
      consecutiveUp = 0;
      trendIds.length = 0;
    }

    if (consecutiveDown >= TREND_MIN_PERIODS || consecutiveUp >= TREND_MIN_PERIODS) {
      candidates.push({
        scanType: "trend",
        source: "transaction",
        suggestedUrgency: "weekly",
        evidence_event_ids: trendIds.slice(),
        description: `${consecutiveDown >= TREND_MIN_PERIODS ? "Declining" : "Rising"} trend over ${Math.max(consecutiveDown, consecutiveUp)} periods`,
        score: Math.max(consecutiveDown, consecutiveUp),
      });
      break;
    }
  }

  return candidates;
}

function scanSilence(events: TimelineEvent[], baselines: Baseline[]): ScanCandidate[] {
  const candidates: ScanCandidate[] = [];

  const intervalBaseline = baselines.find(
    (b) => b.metric_key === "schedule_interval" && b.is_established,
  );
  if (!intervalBaseline) return candidates;

  const scheduleEvents = events
    .filter((e) => e.event_type === "schedule")
    .sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());

  if (scheduleEvents.length === 0) return candidates;

  const lastEvent = scheduleEvents[0];
  const daysSinceLast =
    (Date.now() - new Date(lastEvent.occurred_at).getTime()) / (24 * 60 * 60 * 1000);

  if (daysSinceLast > intervalBaseline.median * SILENCE_MULTIPLIER) {
    candidates.push({
      scanType: "silence",
      source: "schedule",
      suggestedUrgency: "weekly",
      evidence_event_ids: [lastEvent.event_id],
      description: `No schedule event for ${Math.round(daysSinceLast)} days (expected every ${intervalBaseline.median} days)`,
      score: daysSinceLast / intervalBaseline.median,
    });
  }

  return candidates;
}

// Metric change scan: detect monotonic worsening across event types
// Groups events by (event_type, metric_key) and detects 3+ consecutive worsening values
function scanMetricChange(events: TimelineEvent[]): ScanCandidate[] {
  const candidates: ScanCandidate[] = [];

  const extractors: Array<{
    eventType: string;
    metricKey: string;
    extract: (m: Record<string, unknown>) => number | undefined;
    direction: "increasing_is_bad" | "decreasing_is_bad";
    label: string;
  }> = [
    {
      eventType: "communication",
      metricKey: "reply_time_hours",
      extract: (m) => m.reply_time_hours as number | undefined,
      direction: "increasing_is_bad",
      label: "Reply time worsening",
    },
    {
      eventType: "web",
      metricKey: "inquiry_count",
      extract: (m) => m.inquiry_count as number | undefined,
      direction: "decreasing_is_bad",
      label: "Inquiry count declining",
    },
    {
      eventType: "attendance",
      metricKey: "late_hours",
      extract: (m) => m.late_hours as number | undefined,
      direction: "increasing_is_bad",
      label: "Overtime hours increasing",
    },
  ];

  for (const ext of extractors) {
    const relevant = events
      .filter((e) => e.event_type === ext.eventType)
      .sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());

    const dataPoints = relevant
      .map((e) => ({ event_id: e.event_id, value: ext.extract(e.metrics) }))
      .filter((d): d is { event_id: string; value: number } => d.value !== undefined);

    if (dataPoints.length < 3) continue;

    const recent = dataPoints.slice(-Math.min(dataPoints.length, 5));
    let isWorsening = true;
    for (let i = 1; i < recent.length; i++) {
      if (ext.direction === "increasing_is_bad") {
        if (recent[i].value <= recent[i - 1].value) {
          isWorsening = false;
          break;
        }
      } else {
        if (recent[i].value >= recent[i - 1].value) {
          isWorsening = false;
          break;
        }
      }
    }

    if (isWorsening && recent.length >= 3) {
      const first = recent[0].value;
      const last = recent[recent.length - 1].value;
      candidates.push({
        scanType: "deviation",
        source: ext.eventType,
        suggestedUrgency: "weekly",
        evidence_event_ids: recent.map((d) => d.event_id),
        description: `${ext.label}: ${first} → ${last} (${recent.length} consecutive points)`,
        score: Math.abs(last - first) / (Math.abs(first) || 1),
      });
    }
  }

  return candidates;
}

function scanDeadline(events: TimelineEvent[]): ScanCandidate[] {
  const candidates: ScanCandidate[] = [];

  for (const event of events) {
    if (event.metrics.is_overdue === true) {
      candidates.push({
        scanType: "deadline",
        source: "deadline",
        suggestedUrgency: "immediate",
        evidence_event_ids: [event.event_id],
        description: `Overdue: ${event.metrics.expected_date || "unknown date"}`,
        score: 1,
      });
    }
  }

  return candidates;
}

function scanExternal(events: TimelineEvent[]): ScanCandidate[] {
  const candidates: ScanCandidate[] = [];

  for (const event of events) {
    if (event.event_type === "external" && event.sensitivity === "S0") {
      candidates.push({
        scanType: "external",
        source: "external",
        suggestedUrgency: "monthly",
        evidence_event_ids: [event.event_id],
        description: `External signal: ${event.metrics.relevance || event.source}`,
        score: 0.5,
      });
    }
  }

  return candidates;
}

function scanMonitor(events: TimelineEvent[]): ScanCandidate[] {
  const candidates: ScanCandidate[] = [];

  for (const event of events) {
    if (event.event_type === "monitor") {
      const status = event.metrics.status as string | undefined;
      if (status === "down") {
        candidates.push({
          scanType: "deviation",
          source: "monitor",
          suggestedUrgency: "immediate",
          evidence_event_ids: [event.event_id],
          description: `Site down: ${event.metrics.url || "unknown"}`,
          score: 10,
        });
      }
    }
  }

  return candidates;
}
