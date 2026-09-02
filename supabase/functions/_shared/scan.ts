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

/** 平常の間隔の何倍空いたら「途絶」と見なすか。定数1つで固定する */
const SILENCE_MULTIPLIER = 3;

/** シリーズ単位の判定に必要な最低の間隔数。これ未満は「平常」が定まらないので見ない */
const SERIES_MIN_INTERVALS = 3;

/**
 * イベントを「シリーズ」に束ねる鍵。**本番の取り込みが実際に入れている値を先に見る。**
 *
 * 取り込みが `metrics` に何を入れるかは経路ごとに違う。
 *
 *   - カレンダー（`sync-connections`）→ `title`
 *   - 入出金CSV（`csv/ingest`）      → `description`（摘要＝取引先に相当）
 *
 * 合成会社は別の鍵を使っている（`meeting_type` / `order_client`）ので、
 * **両方を候補として順に見る。** 本番の鍵を先に置いてあるのは、
 * 本番で効かない実装にしないためである（このセッションで繰り返し踏んだ形）。
 */
const SERIES_KEYS: Record<string, readonly string[]> = {
  schedule: ["title", "meeting_type"],
  transaction: ["order_client", "description"],
};

function seriesKeyOf(event: ScanEvent): string | null {
  const candidates = SERIES_KEYS[event.event_type];
  if (!candidates) return null;
  const metrics = event.metrics as Record<string, unknown> | null;
  for (const key of candidates) {
    const value = metrics?.[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

/** 中央値。間隔の「平常」を頑健に取るために平均は使わない */
function median(sorted: readonly number[]): number {
  const n = sorted.length;
  return n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
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
export function runScan(
  events: ScanEvent[],
  baselines: ScanBaseline[],
  now: number = Date.now(),
): ScanCandidate[] {
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

  // 6. Silence scan（途絶）— 予定が平常の間隔を大きく超えて空いている
  //
  // **守れない範囲（設計上の限界。仕様であって不具合ではない）。**
  // これが見ているのは「**会社の予定が丸ごと途絶えた**」であって、
  // 「**毎週の定例が消えた**」ではない。ベースラインが会社全体（`entity_id = null`）だからである。
  // 会議が密な会社は平常の間隔が1日前後になり、3倍でも3日なので**ほぼ発火しない**。
  // 定例シリーズごとに見るには `entities` 行の生成（シリーズの同定キーの決定）が要り、
  // それは別の作業である（2026-08-31 梶谷さん判断で、まず会社全体を作った）。
  // **合格線に届いたことを「検知が十分になった」と読まないこと。**
  const intervalBaseline = baselines.find(
    (b) => b.metric_key === "schedule_interval" && b.is_established,
  );
  if (intervalBaseline) {
    const scheduleEvents = events
      .filter((e) => e.event_type === "schedule")
      .sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());

    if (scheduleEvents.length > 0) {
      const lastEvent = scheduleEvents[0];
      const daysSinceLast =
        (now - new Date(lastEvent.occurred_at).getTime()) / (24 * 60 * 60 * 1000);

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
    }
  }

  // 7 / 8. シリーズ単位の間隔を見る（途絶と伸長は**同じ間隔列**から出る）
  //
  // 走査6 は会社全体の予定間隔で、「予定が丸ごと途絶えた」しか捉えない。
  // ここはイベントを**シリーズ**（定例の名前・取引先）に束ね、その系列ごとに見る。
  //
  //   7. 途絶   : 直近からの経過が、平常の間隔の SILENCE_MULTIPLIER 倍を超えた
  //   8. 伸長   : 間隔が単調に伸びている（＝離れていく兆候）
  //
  // **縮む側は検知しない。** 発注が増えるのは良い兆候であり、アラートにする意味がない。
  const bySeries = new Map<string, ScanEvent[]>();
  for (const event of events) {
    const key = seriesKeyOf(event);
    if (key === null) continue;
    const id = `${event.event_type}:${key}`;
    const list = bySeries.get(id) ?? [];
    list.push(event);
    bySeries.set(id, list);
  }

  for (const [id, group] of bySeries) {
    const ordered = [...group].sort(
      (a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime(),
    );

    const intervals: number[] = [];
    for (let i = 1; i < ordered.length; i++) {
      const days =
        (new Date(ordered[i].occurred_at).getTime() -
          new Date(ordered[i - 1].occurred_at).getTime()) /
        (24 * 60 * 60 * 1000);
      intervals.push(days);
    }
    // 平常が定まらない系列は見ない（抑制①「ベースライン未成立は対象外」と同じ趣旨）
    if (intervals.length < SERIES_MIN_INTERVALS) continue;

    const label = id.slice(id.indexOf(":") + 1);
    const eventType = id.slice(0, id.indexOf(":"));
    const usual = median([...intervals].sort((a, b) => a - b));

    // 7. 途絶
    const last = ordered[ordered.length - 1];
    const sinceLast = (now - new Date(last.occurred_at).getTime()) / (24 * 60 * 60 * 1000);
    if (usual > 0 && sinceLast > usual * SILENCE_MULTIPLIER) {
      candidates.push({
        scanType: "silence",
        source: eventType,
        suggestedUrgency: "weekly",
        evidence_event_ids: ordered.map((e) => e.event_id),
        description: `${label}: no event for ${Math.round(sinceLast)} days (usual ${usual} days)`,
        score: sinceLast / usual,
      });
    }

    // 8. 伸長（単調に伸びている）
    const growing = intervals.every((v, i) => i === 0 || v > intervals[i - 1]);
    if (growing) {
      candidates.push({
        scanType: "trend",
        source: eventType,
        suggestedUrgency: "weekly",
        evidence_event_ids: ordered.map((e) => e.event_id),
        description: `${label}: interval elongating ${intervals[0]} → ${intervals[intervals.length - 1]} days (${intervals.length} gaps)`,
        score: intervals[intervals.length - 1] / (intervals[0] || 1),
      });
    }
  }

  return candidates;
}
