/**
 * Scanner の検知ロジック（**本番が動かす実体**）。
 *
 * `scan/index.ts` にべた書きされていたものを、**1行も変えずに**ここへ移した。
 *
 * **なぜ切り出したか（2026-08-31）。**
 * 検知が Edge Function のハンドラ内に閉じていたため、**import できず、測れなかった。**
 * その結果、評価スイート（`tests/eval/engine.test.ts`）は
 * `src/sense/scanner.ts` という**本番で走っていない別実装**を測り続けていた。
 * 6週間、製品の中核が測られないまま「5/7」という数字だけが出ていた。
 *
 * ここに置くことで、評価スイートが**本番と同じコード**を測れるようになる。
 * 検知の中身（何を見るか・どう名付けるか）はこの変更では触っていない。
 * それは別の判断であり `docs/spec/07_open_items.md` に登録済みである。
 */

export interface ScanCandidate {
  scanType: string;
  source: string;
  suggestedUrgency: string;
  evidence_event_ids: string[];
  description: string;
  score: number;
}

/** 走査が見るイベントの部分。`events` の select と同じ形 */
export interface ScanEvent {
  event_id: string;
  occurred_at: string;
  event_type: string;
  source: string;
  metrics: unknown;
  sensitivity: string;
}

/** 走査が見るベースライン。`toFlatBaselines` の出力と同じ形 */
export interface ScanBaseline {
  metric_key: string;
  is_established: boolean;
  median: number;
  iqr: number;
  p25: number;
  p75: number;
  count: number;
}

const metricExtractors: Array<{
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

/**
 * 5つの走査を回して候補を返す。**LLM を使わない。**
 *
 * 中身は `scan/index.ts` にあったものと同一である。移設にあたって
 * `events || []` が引数になった以外の変更はしていない。
 */
export function runScan(events: ScanEvent[], baselines: ScanBaseline[]): ScanCandidate[] {
  const candidates: ScanCandidate[] = [];
  const established = baselines.filter((b) => b.is_established);

  // 1. Deviation scan
  for (const event of events) {
    if (event.event_type !== "transaction") continue;
    const revenue = (event.metrics as Record<string, unknown>)?.revenue as number | undefined;
    if (revenue === undefined) continue;

    for (const bl of established) {
      if (bl.metric_key !== "revenue") continue;
      const lowerBound = bl.p25 - 1.5 * bl.iqr;
      const upperBound = bl.p75 + 1.5 * bl.iqr;
      if (revenue < lowerBound || revenue > upperBound) {
        candidates.push({
          scanType: "deviation",
          source: "transaction",
          suggestedUrgency: "weekly",
          evidence_event_ids: [event.event_id],
          description: `Revenue ${revenue} outside [${lowerBound}, ${upperBound}]`,
          score: Math.abs(revenue - bl.median) / bl.iqr,
        });
      }
    }
  }

  // 2. Deadline scan
  for (const event of events) {
    if ((event.metrics as Record<string, unknown>)?.is_overdue === true) {
      candidates.push({
        scanType: "deadline",
        source: "deadline",
        suggestedUrgency: "immediate",
        evidence_event_ids: [event.event_id],
        description: `Overdue: ${(event.metrics as Record<string, unknown>)?.expected_date || "unknown"}`,
        score: 1,
      });
    }
  }

  // 3. External scan (S0)
  for (const event of events) {
    if (event.event_type === "external" && event.sensitivity === "S0") {
      candidates.push({
        scanType: "external",
        source: "external",
        suggestedUrgency: "monthly",
        evidence_event_ids: [event.event_id],
        description: `External: ${(event.metrics as Record<string, unknown>)?.relevance || event.source}`,
        score: 0.5,
      });
    }
  }

  // 4. Monitor scan (site down → immediate)
  for (const event of events) {
    if (event.event_type === "monitor") {
      const status = (event.metrics as Record<string, unknown>)?.status;
      if (status === "down") {
        candidates.push({
          scanType: "deviation",
          source: "monitor",
          suggestedUrgency: "immediate",
          evidence_event_ids: [event.event_id],
          description: `Site down: ${(event.metrics as Record<string, unknown>)?.url || "unknown"}`,
          score: 10,
        });
      }
    }
  }

  // 5. Metric change scan — detect monotonic worsening across event types
  for (const extractor of metricExtractors) {
    const relevantEvents = events
      .filter((e) => e.event_type === extractor.eventType)
      .sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());

    const dataPoints = relevantEvents
      .map((e) => ({
        event_id: e.event_id,
        value: extractor.extract(e.metrics as Record<string, unknown>),
      }))
      .filter((d): d is { event_id: string; value: number } => d.value !== undefined);

    if (dataPoints.length < 3) continue;

    // Check last 3+ points for monotonic worsening
    const recent = dataPoints.slice(-Math.min(dataPoints.length, 5));
    let isWorsening = true;
    for (let i = 1; i < recent.length; i++) {
      if (extractor.direction === "increasing_is_bad") {
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
        // **傾向であって乖離ではない。** 仕様 `docs/spec/03_sense.md` は
        // 乖離＝平常レンジ逸脱 / 傾向＝連続N期同方向 と定義している。
        // この走査は**ベースラインを一度も参照しない**（reply_time にも inquiry にも
        // 平常レンジが存在しない）。レンジを見ない検出器が「レンジ逸脱」を名乗れない
        scanType: "trend",
        source: extractor.eventType,
        suggestedUrgency: "weekly",
        evidence_event_ids: recent.map((d) => d.event_id),
        description: `${extractor.label}: ${first} → ${last} (${recent.length} consecutive points)`,
        score: Math.abs(last - first) / (Math.abs(first) || 1),
      });
    }
  }

  return candidates;
}
