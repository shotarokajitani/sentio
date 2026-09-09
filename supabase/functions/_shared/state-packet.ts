/**
 * 状態パケット（契約PS の PS-1 / PS-2・発注書 ①-a）。**LLM を通らない。**
 *
 * ここが組むのは「会社の状態を決定的に並べたもの」であり、翻訳（PS-3）はまだ無い。
 * **翻訳を先に載せると、読めない原因がパケットの中身なのか翻訳なのか切り分けられなくなる。**
 *
 * ## 2つの原則
 *
 * - **PS-1: 決定的である。** 同じ入力からは同じパケットが出る。乱数も LLM も時刻依存の
 *   丸めも使わない（`generatedAt` は引数で受け取る）
 * - **PS-2: 値が無い項目を省略しない。** 「無い」と書く。省略すると、
 *   **見ていないことと、見て何も無かったことが同じ顔になる**
 *
 * ## 走査の3値（PS-S1 の項目8）
 *
 * 「走査8本、候補0件」とまとめない。**回して0件だったのと、回せなかったのは別のこと**である。
 * 回せるかどうかは、各走査が読む値の有無から**機械的に**出す（人が書いた表を持たない）。
 */

import { runScan, seriesKeyOf, type ScanBaseline, type ScanCandidate } from "./scan.ts";
import { scheduleDayIntervals } from "./baseline-stats.ts";
import { jstDateKey } from "./jst.ts";

/**
 * 取り込みの経路（＝`events.source` に入りうる値）。**項目9(a) と突き合わせる。**
 *
 * `_shared/retention.ts` の `SOURCES_BY_PROVIDER` が持つ provider 由来の source と、
 * CSV 取り込みの source を合わせたもの。**片方だけ増えたら
 * `tests/unit/state-packet.test.ts` が落ちる**（項目9(a) が実装と食い違ったことに気づく形）。
 */
export const INGEST_ROUTES = ["google_calendar", "freee", "csv:accounting"] as const;

/** 予定の取り込み周期（時間）。cron を6時間のまま据え置いた判断（契約PS §7-3）と対になる */
export const INGEST_INTERVAL_HOURS = 6;

/** 系列として見るのに必要な間隔の本数。`scan.ts` の `SERIES_MIN_INTERVALS` と同じ値 */
export const SERIES_MIN_INTERVALS = 3;

/** 傾向（悪化）の走査が判定に要る最低のデータ点数。`scan.ts` の実装と同じ値 */
const TREND_MIN_POINTS = 3;

// ──────────────────────────────────────────────────────────
// 入力
// ──────────────────────────────────────────────────────────

export interface PacketConnection {
  provider: string;
  status: string;
  expires_at: string | null;
  last_refresh: string | null;
  revoked_at: string | null;
}

export interface PacketEvent {
  event_id: string;
  source: string;
  event_type: string;
  occurred_at: string;
  ingested_at: string;
  metrics: unknown;
  sensitivity: string;
}

export interface PacketBaselineRow {
  metric_key: string;
  is_established: boolean;
  min_obs: number | null;
  stats: unknown;
}

/**
 * 入金（項目7）の材料。**今回は変換を実装しない。**
 * 枠だけ先に用意し、空で出す。将来のスライスがここを埋める。
 */
export interface PacketDepositInput {
  /** (a) 件数と金額 */
  count: number | null;
  amount: number | null;
  /** (b) 除外した件数と金額（PS-R-2） */
  excludedCount: number | null;
  excludedAmount: number | null;
  /** (c) 対応づけられなかった列の名前と、金額が入らなかった行数（PS-R-1） */
  unmappedColumns: string[];
  rowsWithoutAmount: number;
}

export interface PacketInput {
  /** パケットを組んだ時刻。**引数で受け取る**（決定的にするため） */
  generatedAt: Date;
  /** 報告対象日（JST の YYYY-MM-DD） */
  reportDate: string;
  connections: PacketConnection[];
  events: PacketEvent[];
  baselines: PacketBaselineRow[];
  /** 省略時は「変換が無い」状態として空で出す */
  deposits?: PacketDepositInput;
}

// ──────────────────────────────────────────────────────────
// 出力
// ──────────────────────────────────────────────────────────

/**
 * 連携の3値（2026-09-09 に定義を改めた）。**`status` 単独で「つながっている」と書かない。**
 *
 * `stopped` は「判断がつかない」の置き換えである。**判断はつく。**
 * 直近の取り込みが成功しているかは分かるので、**分かることを分からないと書かない。**
 */
export type LinkState = "connected" | "revoked" | "stopped" | "absent";

export interface PacketLink {
  provider: string;
  state: LinkState;
  /** 最後に**取り込みに成功**した時刻（`connections.last_refresh`） */
  lastSuccessAt: string | null;
  revokedAt: string | null;
  /** `stopped` のとき、成功以降に過ぎた取り込みの窓の数 */
  missedWindows: number;
  /**
   * 次に取り込む時刻（ISO）。**相対時間で書かない。**
   *
   * 「6時間後」と書くと、読み手は**いまから**6時間後と読む。実際の起点は
   * 直近の窓であり、本番のパルス（22:00 UTC）では**4時間ずれる**
   * （直前の取り込み 18:00 UTC・次の窓 00:00 UTC・実際の待ちは2時間）。
   */
  nextAt: string | null;
}

export interface PacketFreshness {
  source: string;
  lastIngestedAt: string | null;
  lastOccurredAt: string | null;
}

export interface PacketDensity {
  established: boolean;
  median: number | null;
  p25: number | null;
  p75: number | null;
  count: number | null;
  /** 確立に必要な観測数（`baselines.min_obs`）。行が無ければ null */
  minObs: number | null;
  /** あと何件必要か。観測数を数えられないときは null */
  remaining: number | null;
}

export interface PacketSeries {
  label: string;
  eventType: string;
  intervals: number;
  usualDays: number | null;
  daysSinceLast: number | null;
}

export type ScanState =
  | { kind: "unavailable"; reason: string }
  | { kind: "empty" }
  | { kind: "candidates"; count: number };

export interface PacketScan {
  id: string;
  label: string;
  state: ScanState;
}

export interface PacketDeposits {
  available: boolean;
  count: number | null;
  amount: number | null;
  excludedCount: number | null;
  excludedAmount: number | null;
  unmappedColumns: string[];
  rowsWithoutAmount: number;
  /** **金額を確からしい値として出してよいか。** (c) が0でない日は false */
  trustworthy: boolean;
}

export interface StatePacket {
  reportDate: string;
  generatedAtJst: string;
  ingestIntervalHours: number;
  links: PacketLink[];
  freshness: PacketFreshness[];
  density: PacketDensity;
  lastSchedule: { occurredAt: string | null; daysSince: number | null };
  series: PacketSeries[];
  deposits: PacketDeposits;
  scans: PacketScan[];
  blindSpots: { noRoute: string[]; noValue: string[]; byDesign: string[] };
}

// ──────────────────────────────────────────────────────────
// 項目9 — 見えていないもの（この契約の芯）
// ──────────────────────────────────────────────────────────

/**
 * (a) 取り込む経路が無いもの。**承認済みの一覧（2026-09-09 検収者）。**
 *
 * **実装と食い違ったときに気づける形にしてある。** `INGEST_ROUTES` が増えたら
 * `tests/unit/state-packet.test.ts` の突合が落ちるので、そこで人が並べ直す。
 *
 * **「会計（自動）」は 2026-09-09 に外した。** freee は経路がコード上に存在し
 * （`src/app/auth/callback/freee/route.ts`）、項目2 と項目3 にも毎日出ている。
 * **出ているものを「経路が無い」と書かない。** 繋がっていないことは
 * 項目2 が「連携していません」と毎日書くので、情報は落ちない。
 */
const BLIND_NO_ROUTE = [
  "売上（Stripe など）",
  "勤怠",
  "メールとチャット",
  "サイトの監視",
  "受注と請求",
] as const;

/** (b) 経路はあるが値が来ていないもの */
const BLIND_NO_VALUE = [
  "入金額（金額の列は取り込んでいるが、入金として集計する処理がまだない）",
] as const;

/**
 * (c) 構造上、見ていないもの。**落とすと「経路をつなげば全部見える」と読める。**
 *
 * 走査6の限界はベースラインが会社全体であることに由来し、**経路をつないでも解けない。**
 * 設計の問題であって経路の問題ではない。
 */
const BLIND_BY_DESIGN = [
  "定例が1本だけ消えたこと（見ているのは予定が丸ごと途絶えたかどうか）",
  "間隔が3回に届かない取引先の変化",
  "取引が増えた側の変化（減った側だけを見ている）",
  "請求と入金のずれ",
  "勘定科目ごとの動き（科目・税区分・相手勘定を取り込んでいない）",
] as const;

// ──────────────────────────────────────────────────────────
// 走査の同定（8本を1本ずつ）
// ──────────────────────────────────────────────────────────

/**
 * 走査の一覧。**`scan.ts` の8本と1対1で対応する。**
 *
 * `runScan` の候補は `scanType` が5種類しか無く、走査6と7（どちらも `silence`）、
 * 走査5と8（どちらも `trend`）、走査1と4（どちらも `deviation`）が同じ値になる。
 * したがって候補の同定には `source` と、**`scan.ts` が書く description の形**を使う。
 * **この結び付きは試験で固定してある**（`scan.ts` の文言を変えたら赤くなる）。
 */
export const SCAN_IDS = [
  "deviation",
  "deadline",
  "external",
  "monitor",
  "worsening",
  "silence_company",
  "silence_series",
  "elongation_series",
] as const;

export type ScanId = (typeof SCAN_IDS)[number];

const SCAN_LABELS: Record<ScanId, string> = {
  deviation: "乖離（取引の金額が平常のレンジを外れていないか）",
  deadline: "期限（期日を過ぎたものがないか）",
  external: "外部（外の出来事で自社に効くものがないか）",
  monitor: "監視（サイトが落ちていないか）",
  worsening: "悪化（返信の遅さ・問い合わせ数・遅刻が単調に悪化していないか）",
  silence_company: "途絶・会社全体（予定が丸ごと途絶えていないか）",
  silence_series: "途絶・系列（定例や取引先ごとに途絶えていないか）",
  elongation_series: "伸長・系列（間隔が単調に伸びていないか）",
};

/** 候補がどの走査から出たかを決める。**description の形に依存する**（試験で固定） */
export function attributeCandidate(candidate: ScanCandidate): ScanId | null {
  if (candidate.scanType === "deadline") return "deadline";
  if (candidate.scanType === "external") return "external";
  if (candidate.scanType === "deviation") {
    return candidate.source === "monitor" ? "monitor" : "deviation";
  }
  if (candidate.scanType === "silence") {
    // 走査6 は会社全体、走査7 は系列。**description の書き出しで分かれる**
    return candidate.description.startsWith("No schedule event for")
      ? "silence_company"
      : "silence_series";
  }
  if (candidate.scanType === "trend") {
    return candidate.description.includes("interval elongating")
      ? "elongation_series"
      : "worsening";
  }
  return null;
}

// ──────────────────────────────────────────────────────────
// 組み立て
// ──────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function metricsOf(event: PacketEvent): Record<string, unknown> {
  return (event.metrics as Record<string, unknown> | null) ?? {};
}

function maxIso(values: readonly string[]): string | null {
  let max: string | null = null;
  for (const v of values) {
    if (!v) continue;
    if (max === null || Date.parse(v) > Date.parse(max)) max = v;
  }
  return max;
}

function daysBetween(from: string | null, to: Date): number | null {
  if (!from) return null;
  const diff = to.getTime() - Date.parse(from);
  if (Number.isNaN(diff)) return null;
  return Math.floor(diff / DAY_MS);
}

/** JST の「2026年9月9日 14:09」 */
export function formatJst(at: Date): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}年${get("month")}月${get("day")}日 ${get("hour")}:${get("minute")}`;
}

/** 取り込みの窓の始まり（UTC の 0/6/12/18 時）。cron の `sync-connections` と同じ刻み */
function windowStart(at: number): number {
  const d = new Date(at);
  const hours = d.getUTCHours() - (d.getUTCHours() % INGEST_INTERVAL_HOURS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hours);
}

/** 成功から数えて、取り込みの窓をいくつ過ぎたか */
export function missedWindowsSince(lastSuccess: string | null, now: Date): number {
  if (!lastSuccess) return Number.MAX_SAFE_INTEGER;
  const from = Date.parse(lastSuccess);
  if (Number.isNaN(from)) return Number.MAX_SAFE_INTEGER;
  const diff = windowStart(now.getTime()) - windowStart(from);
  return Math.max(0, Math.round(diff / (INGEST_INTERVAL_HOURS * 60 * 60 * 1000)));
}

/**
 * 連携の3値（2026-09-09 に定義を改めた）。**判定は「直近の取り込みの成否」で行う。**
 *
 * ## なぜ `expires_at` を使わないか
 *
 * トークンの寿命は1時間で、取り込みは6時間ごとである。
 * **パケットを組む時点で、期限は必ず数時間前に切れている。**
 * 期限で判定すると毎朝必ず「判断がつかない」が出る。
 * トークンの期限は利用者に見せるものではない（本文にも出さない）。**内部事情である。**
 *
 * ## 何を見ているか
 *
 * `connections.last_refresh` は **`sync-connections` が取り込みに成功した後にだけ**
 * 更新される（`sync-connections/index.ts` の 2f）。失敗した回は更新されない。
 * したがって「最後に取り込みに成功した時刻」として読める。
 *
 * **窓を2つ以上またいだら止まっているとみなす。** 1つ（＝いまの窓でまだ動いていない）は
 * 正常な待ちである——組む時刻が窓の直後なら、その回の取り込みはまだ走っていない。
 */
export function linkStateOf(connection: PacketConnection, now: Date): LinkState {
  const status = (connection.status ?? "").trim();
  if (status === "revoked" || status === "reauth_required") return "revoked";
  return missedWindowsSince(connection.last_refresh, now) >= 2 ? "stopped" : "connected";
}

function buildLinks(input: PacketInput): PacketLink[] {
  const byProvider = new Map<string, PacketConnection>();
  for (const c of input.connections) byProvider.set(c.provider, c);

  const providers = [
    ...new Set([...INGEST_ROUTES.filter((s) => !s.startsWith("csv:")), ...byProvider.keys()]),
  ].sort();

  return providers.map((provider) => {
    const c = byProvider.get(provider);
    if (!c) {
      // **行が無いことも書く。** 省略すると「見ていない」と同じ顔になる
      return {
        provider,
        state: "absent" as const,
        lastSuccessAt: null,
        revokedAt: null,
        missedWindows: 0,
        nextAt: null,
      };
    }
    // **起点は「いまの窓の次」である。** 最後の取り込みからの6時間ではない
    const nextWindow = windowStart(input.generatedAt.getTime()) + INGEST_INTERVAL_HOURS * 3600000;
    return {
      provider,
      state: linkStateOf(c, input.generatedAt),
      lastSuccessAt: c.last_refresh,
      revokedAt: c.revoked_at,
      missedWindows: c.last_refresh ? missedWindowsSince(c.last_refresh, input.generatedAt) : 0,
      nextAt: new Date(nextWindow).toISOString(),
    };
  });
}

function buildFreshness(input: PacketInput): PacketFreshness[] {
  const sources = [...new Set([...INGEST_ROUTES, ...input.events.map((e) => e.source)])].sort();

  return sources.map((source) => {
    const rows = input.events.filter((e) => e.source === source);
    return {
      source,
      lastIngestedAt: maxIso(rows.map((e) => e.ingested_at)),
      lastOccurredAt: maxIso(rows.map((e) => e.occurred_at)),
    };
  });
}

function statsOf(row: PacketBaselineRow | undefined): Record<string, unknown> {
  return ((row?.stats as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildDensity(input: PacketInput): PacketDensity {
  const row = input.baselines.find((b) => b.metric_key === "schedule_interval");
  const stats = statsOf(row);

  // **確立していないとき、stats の中身を1つも書かない。** 空の統計を 0 と書かない
  if (!row || !row.is_established) {
    const intervals = scheduleDayIntervals(
      input.events.filter((e) => e.event_type === "schedule").map((e) => e.occurred_at),
    );
    const minObs = row?.min_obs ?? null;
    return {
      established: false,
      median: null,
      p25: null,
      p75: null,
      count: null,
      minObs,
      remaining: minObs === null ? null : Math.max(0, minObs - intervals.length),
    };
  }

  return {
    established: true,
    median: numberOrNull(stats.median),
    p25: numberOrNull(stats.p25),
    p75: numberOrNull(stats.p75),
    count: numberOrNull(stats.count),
    minObs: row.min_obs,
    remaining: null,
  };
}

/** 取引を系列に束ねる。**鍵は `scan.ts` の `seriesKeyOf` に合わせる**（本番で効く形にする） */
function buildSeries(input: PacketInput): PacketSeries[] {
  const groups = new Map<string, PacketEvent[]>();

  for (const event of input.events) {
    if (event.event_type !== "transaction") continue;
    const key = seriesKeyOf({
      event_id: event.event_id,
      occurred_at: event.occurred_at,
      event_type: event.event_type,
      source: event.source,
      metrics: event.metrics,
      sensitivity: event.sensitivity,
    });
    if (key === null) continue;
    const list = groups.get(key) ?? [];
    list.push(event);
    groups.set(key, list);
  }

  const series: PacketSeries[] = [];
  for (const [label, group] of groups) {
    const ordered = [...group].sort(
      (a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at),
    );
    const intervals: number[] = [];
    for (let i = 1; i < ordered.length; i++) {
      intervals.push(
        (Date.parse(ordered[i].occurred_at) - Date.parse(ordered[i - 1].occurred_at)) / DAY_MS,
      );
    }
    const sorted = [...intervals].sort((a, b) => a - b);
    const usual =
      sorted.length === 0
        ? null
        : sorted.length % 2 === 1
          ? sorted[(sorted.length - 1) / 2]
          : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

    series.push({
      label,
      eventType: "transaction",
      intervals: intervals.length,
      usualDays: usual,
      daysSinceLast: daysBetween(ordered[ordered.length - 1].occurred_at, input.generatedAt),
    });
  }

  return series.sort((a, b) => a.label.localeCompare(b.label));
}

function buildDeposits(input: PacketInput): PacketDeposits {
  const d = input.deposits;
  const rowsWithoutAmount = d?.rowsWithoutAmount ?? 0;
  const amount = d?.amount ?? null;

  return {
    // 変換（PS-R）が無いので、いまは必ず「出せない」
    available: amount !== null,
    count: d?.count ?? null,
    amount,
    excludedCount: d?.excludedCount ?? null,
    excludedAmount: d?.excludedAmount ?? null,
    unmappedColumns: d?.unmappedColumns ?? [],
    rowsWithoutAmount,
    // **(c) の行数が0でない日に、入金額を確からしい値として出さない**
    trustworthy: amount !== null && rowsWithoutAmount === 0,
  };
}

/** 悪化の走査が見る3系列（`scan.ts` の `metricExtractors` と同じ組） */
const WORSENING_SERIES: ReadonlyArray<{ eventType: string; metricKey: string }> = [
  { eventType: "communication", metricKey: "reply_time_hours" },
  { eventType: "web", metricKey: "inquiry_count" },
  { eventType: "attendance", metricKey: "late_hours" },
];

function buildScans(input: PacketInput, candidates: ScanCandidate[]): PacketScan[] {
  const events = input.events;
  const counts = new Map<ScanId, number>();
  for (const c of candidates) {
    const id = attributeCandidate(c);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const revenueBaseline = input.baselines.find((b) => b.metric_key === "revenue");
  const revenueEvents = events.filter(
    (e) => e.event_type === "transaction" && typeof metricsOf(e).revenue === "number",
  );

  const overdueEvents = events.filter((e) => "is_overdue" in metricsOf(e));
  const externalEvents = events.filter(
    (e) => e.event_type === "external" && e.sensitivity === "S0",
  );
  const monitorEvents = events.filter((e) => e.event_type === "monitor");

  const worseningPoints = WORSENING_SERIES.map(({ eventType, metricKey }) => ({
    eventType,
    points: events.filter(
      (e) => e.event_type === eventType && typeof metricsOf(e)[metricKey] === "number",
    ).length,
  }));
  const worseningMax = Math.max(...worseningPoints.map((p) => p.points));

  const intervalBaseline = input.baselines.find(
    (b) => b.metric_key === "schedule_interval" && b.is_established,
  );
  const scheduleEvents = events.filter((e) => e.event_type === "schedule");

  // **「値が無い」と「値はあるが条件に届かない」を混ぜない**（2026-09-09）
  const worseningReason =
    worseningMax === 0
      ? "返信の遅さ・問い合わせ数・遅刻に該当するイベントが0件"
      : `値はあるが、判定に要る${TREND_MIN_POINTS}点に届かない（最大 ${worseningMax} 点）`;

  const seriesGroups = countSeries(events);
  const seriesReason =
    seriesGroups.total === 0
      ? "束ねられるイベント（予定の題・取引の摘要）が0件"
      : `系列はあるが、間隔が${SERIES_MIN_INTERVALS}本に届かない（最大 ${seriesGroups.maxIntervals} 本）`;

  const unavailable = (reason: string): ScanState => ({ kind: "unavailable", reason });
  const ran = (id: ScanId): ScanState => {
    const n = counts.get(id) ?? 0;
    return n === 0 ? { kind: "empty" } : { kind: "candidates", count: n };
  };

  const states: Record<ScanId, ScanState> = {
    deviation:
      revenueEvents.length === 0
        ? unavailable("取引に金額（metrics.revenue）が1件も入っていない")
        : !revenueBaseline || !revenueBaseline.is_established
          ? unavailable("入金のベースラインが確立していない")
          : ran("deviation"),
    deadline:
      overdueEvents.length === 0
        ? unavailable("期日の情報（metrics.is_overdue）を持つイベントが0件")
        : ran("deadline"),
    external:
      externalEvents.length === 0
        ? unavailable("外部イベント（event_type='external' かつ S0）が0件")
        : ran("external"),
    monitor:
      monitorEvents.length === 0
        ? unavailable("監視イベント（event_type='monitor'）が0件")
        : ran("monitor"),
    worsening: worseningMax < TREND_MIN_POINTS ? unavailable(worseningReason) : ran("worsening"),
    silence_company:
      scheduleEvents.length === 0
        ? unavailable("予定のイベントが0件")
        : !intervalBaseline
          ? unavailable("予定はあるが、間隔の平常がまだ定まっていない")
          : ran("silence_company"),
    silence_series:
      seriesGroups.withEnoughIntervals === 0 ? unavailable(seriesReason) : ran("silence_series"),
    elongation_series:
      seriesGroups.withEnoughIntervals === 0 ? unavailable(seriesReason) : ran("elongation_series"),
  };

  return SCAN_IDS.map((id) => ({ id, label: SCAN_LABELS[id], state: states[id] }));
}

/**
 * `scan.ts` の系列走査が見る系列を数える。
 * **「束ねられるものが無い」と「束ねたが間隔が足りない」を区別する**ために両方返す。
 */
function countSeries(events: readonly PacketEvent[]): {
  total: number;
  withEnoughIntervals: number;
  maxIntervals: number;
} {
  const groups = new Map<string, number>();
  for (const event of events) {
    const key = seriesKeyOf({
      event_id: event.event_id,
      occurred_at: event.occurred_at,
      event_type: event.event_type,
      source: event.source,
      metrics: event.metrics,
      sensitivity: event.sensitivity,
    });
    if (key === null) continue;
    const id = `${event.event_type}:${key}`;
    groups.set(id, (groups.get(id) ?? 0) + 1);
  }
  let withEnoughIntervals = 0;
  let maxIntervals = 0;
  for (const count of groups.values()) {
    const intervals = count - 1;
    if (intervals >= SERIES_MIN_INTERVALS) withEnoughIntervals++;
    if (intervals > maxIntervals) maxIntervals = intervals;
  }
  return { total: groups.size, withEnoughIntervals, maxIntervals };
}

/** 走査に渡すベースライン（`ScanBaseline` の形）。stats が空の行は落とす */
function toScanBaselines(rows: readonly PacketBaselineRow[]): ScanBaseline[] {
  const out: ScanBaseline[] = [];
  for (const row of rows) {
    const stats = statsOf(row);
    const median = numberOrNull(stats.median);
    const p25 = numberOrNull(stats.p25);
    const p75 = numberOrNull(stats.p75);
    const count = numberOrNull(stats.count);
    if (median === null || p25 === null || p75 === null || count === null) continue;
    out.push({
      metric_key: row.metric_key,
      is_established: row.is_established,
      median,
      iqr: p75 - p25,
      p25,
      p75,
      count,
    });
  }
  return out;
}

/** 状態パケットを組む。**決定的である**（`generatedAt` 以外に時刻を見ない） */
export function buildStatePacket(input: PacketInput): StatePacket {
  const scanEvents = input.events.map((e) => ({
    event_id: e.event_id,
    occurred_at: e.occurred_at,
    event_type: e.event_type,
    source: e.source,
    metrics: e.metrics,
    sensitivity: e.sensitivity,
  }));

  const candidates = runScan(
    scanEvents,
    toScanBaselines(input.baselines),
    input.generatedAt.getTime(),
  );

  const lastScheduleAt = maxIso(
    input.events.filter((e) => e.event_type === "schedule").map((e) => e.occurred_at),
  );

  return {
    reportDate: input.reportDate,
    generatedAtJst: formatJst(input.generatedAt),
    ingestIntervalHours: INGEST_INTERVAL_HOURS,
    links: buildLinks(input),
    freshness: buildFreshness(input),
    density: buildDensity(input),
    lastSchedule: {
      occurredAt: lastScheduleAt,
      daysSince: daysBetween(lastScheduleAt, input.generatedAt),
    },
    series: buildSeries(input),
    deposits: buildDeposits(input),
    scans: buildScans(input, candidates),
    blindSpots: {
      noRoute: [...BLIND_NO_ROUTE],
      noValue: [...BLIND_NO_VALUE],
      byDesign: [...BLIND_BY_DESIGN],
    },
  };
}

// ──────────────────────────────────────────────────────────
// 人が読む形にする（整形は最小限。読めればよい）
// ──────────────────────────────────────────────────────────

/**
 * **同じ状態に2つの言い方を持たない**（2026-09-09）。
 * 取り込みが1件も無いことは、項目1・項目3 とも同じ語で書く。
 */
const NOT_INGESTED = "まだ1件も取り込んでいません";

/** **数えていない**ことを 0 と書かない（項目7）。取り込んでいないから 0 なのではない */
const NOT_COUNTED = "まだ数えていません";

function jstDateTime(iso: string | null): string {
  return iso ? formatJst(new Date(iso)) : NOT_INGESTED;
}

/**
 * JST の「9時」。**相対時間（n 時間後）で書かない**（2026-09-09）。
 * 起点を取り違えられない形にする。
 */
function jstHour(iso: string | null): string {
  if (!iso) return "時刻が決まりません";
  const at = new Date(iso);
  const hour = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "numeric",
  }).format(at);
  return hour.endsWith("時") ? hour : `${hour}時`;
}

/** パケットをそのまま読める行に落とす。**項目を1つも省略しない** */
export function renderPacketText(packet: StatePacket): string {
  const lines: string[] = [];
  const push = (line = "") => lines.push(line);

  push(`【1】いつ時点の状態か`);
  push(`このパケットを組んだ時刻: ${packet.generatedAtJst}（JST）`);
  push(`報告対象日: ${packet.reportDate}`);
  push(`予定は${packet.ingestIntervalHours}時間ごとに取り込んでいます。`);
  push(`したがって、ここに出ているのは「いま」ではなく、最後に取り込んだ時点の状態です。`);
  for (const f of packet.freshness) {
    push(
      f.lastIngestedAt === null
        ? `  ${f.source}: ${NOT_INGESTED}`
        : `  ${f.source}: 最後の取り込み ${jstDateTime(f.lastIngestedAt)}`,
    );
  }
  push();

  push(`【2】連携の生死`);
  for (const link of packet.links) {
    if (link.state === "absent") {
      push(`  ${link.provider}: 連携していません（行がありません）`);
    } else if (link.state === "revoked") {
      push(`  ${link.provider}: 連携が切れています（検知 ${jstDateTime(link.revokedAt)}）`);
    } else if (link.state === "connected") {
      push(
        `  ${link.provider}: つながっています（最後の取り込み ${jstDateTime(link.lastSuccessAt)}。` +
          `次の取り込みは ${jstHour(link.nextAt)}ごろです）`,
      );
    } else {
      // **「失敗した回数」ではなく「過ぎた窓の数」を書く。**
      // 取り込みが走って失敗したのか、そもそも走らなかったのかを分ける記録が無い
      push(
        `  ${link.provider}: 取り込みが止まっています（最後の成功 ${jstDateTime(link.lastSuccessAt)}。` +
          `それ以降、取り込みの窓を ${link.missedWindows} 回過ぎましたが、新しい成功がありません）`,
      );
    }
  }
  push();

  push(`【3】取り込みの鮮度`);
  for (const f of packet.freshness) {
    if (f.lastIngestedAt === null && f.lastOccurredAt === null) {
      push(`  ${f.source}: ${NOT_INGESTED}`);
      continue;
    }
    push(
      `  ${f.source}: 取り込んだ日 ${jstDateTime(f.lastIngestedAt)} / ` +
        `データの日付 ${jstDateTime(f.lastOccurredAt)}`,
    );
  }
  push();

  push(`【4】予定の密度`);
  if (!packet.density.established) {
    const n = packet.density.remaining;
    push(
      n === null
        ? `  まだ出せません（平常が定まっていません）`
        : `  まだ出せません（あと ${n} 件必要です）`,
    );
  } else {
    push(
      `  中央値 ${packet.density.median} 日 / 25%点 ${packet.density.p25} 日 / ` +
        `75%点 ${packet.density.p75} 日 / 観測 ${packet.density.count} 件`,
    );
  }
  push();

  push(`【5】予定の直近`);
  if (packet.lastSchedule.occurredAt === null) {
    push(`  予定が1件も入っていません`);
  } else {
    push(
      `  最後の予定 ${jstDateTime(packet.lastSchedule.occurredAt)}（${packet.lastSchedule.daysSince} 日前）`,
    );
  }
  push();

  push(`【6】取引の間隔（系列ごと）`);
  if (packet.series.length === 0) {
    push(`  取引の系列は、まだ束ねられていません`);
  } else {
    for (const s of packet.series) {
      if (s.intervals < SERIES_MIN_INTERVALS) {
        push(`  ${s.label}: まだ平常が定まりません（間隔が ${s.intervals} 本）`);
        continue;
      }
      push(
        `  ${s.label}: 平常 ${s.usualDays} 日 / 間隔 ${s.intervals} 本 / ` +
          `最後から ${s.daysSinceLast} 日`,
      );
    }
  }
  push();

  push(`【7】入金`);
  if (!packet.deposits.available) {
    // **数えていないので、下の3行も 0 と書かない**（2026-09-09）。
    // 取り込んでいないから 0 なのであって、**数えた結果の 0 ではない**
    push(`  入金は出せません。金額の列を読み取れていません`);
    push(`  件数と金額: ${NOT_COUNTED}`);
    push(`  除外: ${NOT_COUNTED}`);
    push(`  対応づけられなかった列: ${NOT_COUNTED} / 金額が入らなかった行: ${NOT_COUNTED}`);
  } else {
    if (!packet.deposits.trustworthy) {
      push(
        `  入金額は出しません。金額が入らなかった行が ${packet.deposits.rowsWithoutAmount} 行あります`,
      );
    } else {
      push(`  件数と金額: ${packet.deposits.count} 件 / ${packet.deposits.amount} 円`);
    }
    push(
      `  除外: ${packet.deposits.excludedCount === null ? NOT_COUNTED : `${packet.deposits.excludedCount} 件 / ${packet.deposits.excludedAmount} 円`}`,
    );
    push(
      `  対応づけられなかった列: ${packet.deposits.unmappedColumns.length === 0 ? "0 件" : packet.deposits.unmappedColumns.join(", ")}` +
        ` / 金額が入らなかった行: ${packet.deposits.rowsWithoutAmount} 行`,
    );
  }
  push();

  push(`【8】走査の結果（8本）`);
  for (const scan of packet.scans) {
    if (scan.state.kind === "unavailable") {
      push(`  ${scan.label}: 入力が無くて回せませんでした（${scan.state.reason}）`);
    } else if (scan.state.kind === "empty") {
      push(`  ${scan.label}: 回して候補0件`);
    } else {
      push(`  ${scan.label}: 候補 ${scan.state.count} 件`);
    }
  }
  push();

  push(`【9】見えていないもの`);
  push(`  取り込む経路が無いもの:`);
  for (const name of packet.blindSpots.noRoute) push(`    ${name}`);
  push(`  経路はあるが値が来ていないもの:`);
  for (const name of packet.blindSpots.noValue) push(`    ${name}`);
  push(`  構造上、見ていないもの:`);
  for (const name of packet.blindSpots.byDesign) push(`    ${name}`);

  return lines.join("\n");
}

/** 冪等キーの対象期間（JST の日付）。`pulse` とも `reconnect` とも衝突させない */
export function packetPeriod(now: Date): string {
  return jstDateKey(now);
}
