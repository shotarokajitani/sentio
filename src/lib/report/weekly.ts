/**
 * 週次レポートの集計（契約 `docs/contracts/slice-weekly-report.md`・スライスW）。
 *
 * **純関数だけを置く。** DB にも Next にも依存させない。
 * 入力は `events` の行の配列、出力は画面がそのまま描ける集計結果である。
 * 受入基準 W-1 系と W-2-1 / W-2-4 は、ここだけでテストできる形にしてある。
 *
 * `baselines` は使わない（W-D2）。`is_established` が false で
 * `observation_count: 0` であり、まだ比較の土台になっていない。
 * 比較は「当週 vs 前週の同じ計算をもう一度回す」だけで済ませる（W-D3）。
 */

/** `events` の行のうち、この集計が見る列だけ。jsonb は形が保証されないので unknown で受ける */
export interface EventRow {
  source: string | null;
  event_type: string | null;
  period_start: string | null;
  period_end: string | null;
  metrics: unknown;
}

export interface Meeting {
  /** `metrics.title`。無い・空・文字列でないときは null（表示側で言い換える） */
  title: string | null;
  startsAt: string;
  endsAt: string;
  /** 終日予定は 0。24時間を総会議時間に混ぜない（W-1-3） */
  minutes: number;
  allDay: boolean;
  /**
   * `metrics.attendees` の要素数（W-1-4）。
   * **メールアドレスそのものはこの型のどこにも載せない**（W-D4 / W-2-1）
   */
  attendeeCount: number;
}

/**
 * 前週比。前週が 0 のときは `available: false` にする。
 *
 * `changePercent: 0` を返す形にしない。「変わらなかった」と
 * 「比べる相手がいない」は別のことであり、0% と書くと前者に読める（W-1-5）。
 */
export type Comparison =
  { available: false } | { available: true; previous: number; changePercent: number };

export interface WeeklySummary {
  /** JST 月曜00:00（UTC 表記）。表示側がここから週を切り直さないために出力に載せる */
  weekStart: string;
  /** 翌 JST 月曜00:00。半開区間の上端 */
  weekEnd: string;
  /** 週内に `period_start` が入る schedule の件数（W-1-2。終日予定も含む） */
  meetingCount: number;
  /** うち終日予定。総会議時間には入らない（W-1-3） */
  allDayCount: number;
  totalMeetingMinutes: number;
  totalAttendees: number;
  meetings: Meeting[];
  meetingCountChange: Comparison;
  meetingMinutesChange: Comparison;
}

/**
 * この集計が会議として数える取り込み元。他 source は数えない（W-2-4）。
 *
 * DB 側の絞り込み（`src/lib/report/events.ts`）と同じ値を使うために公開している。
 * 二重に書くと、片方だけ直したときに**画面と問い合わせがずれる**。
 */
export const MEETING_SOURCE = "google_calendar";
export const MEETING_EVENT_TYPE = "schedule";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** JST は UTC+9 固定。夏時間が無いので、オフセットを定数として扱える */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 基準時刻を含む週の範囲を JST で切る（W-1-1）。
 *
 * 返すのは半開区間 `[start, end)` である。契約の「日曜23:59:59」までを含み、
 * かつ翌週の月曜00:00 を含まない。秒未満を持つ行の扱いが曖昧にならない。
 */
export function jstWeekRange(reference: Date): { start: Date; end: Date } {
  // UTC のフィールド読み出しが JST の壁時計になるようずらしてから切る
  const shifted = reference.getTime() + JST_OFFSET_MS;
  const midnight = Math.floor(shifted / DAY_MS) * DAY_MS;
  const dayOfWeek = new Date(midnight).getUTCDay(); // 0=日曜
  const sinceMonday = (dayOfWeek + 6) % 7;

  const start = new Date(midnight - sinceMonday * DAY_MS - JST_OFFSET_MS);
  return { start, end: new Date(start.getTime() + 7 * DAY_MS) };
}

export function summarizeWeek(rows: EventRow[], reference: Date): WeeklySummary {
  const current = jstWeekRange(reference);
  const previous = jstWeekRange(new Date(current.start.getTime() - DAY_MS));

  const meetings = collect(rows, current.start, current.end);
  const previousMeetings = collect(rows, previous.start, previous.end);

  const totalMeetingMinutes = sumMinutes(meetings);

  return {
    weekStart: current.start.toISOString(),
    weekEnd: current.end.toISOString(),
    meetingCount: meetings.length,
    allDayCount: meetings.filter((m) => m.allDay).length,
    totalMeetingMinutes,
    totalAttendees: meetings.reduce((sum, m) => sum + m.attendeeCount, 0),
    meetings,
    meetingCountChange: compare(meetings.length, previousMeetings.length),
    meetingMinutesChange: compare(totalMeetingMinutes, sumMinutes(previousMeetings)),
  };
}

/** 指定の期間に `period_start` が入る会議を、開始の早い順に取り出す */
function collect(rows: EventRow[], start: Date, end: Date): Meeting[] {
  const meetings: Meeting[] = [];

  for (const row of rows) {
    if (row.source !== MEETING_SOURCE) continue;
    if (row.event_type !== MEETING_EVENT_TYPE) continue;

    const startsAt = parseDate(row.period_start);
    if (!startsAt) continue;
    if (startsAt < start || startsAt >= end) continue;

    // 終了が読めない行は0分として通す。集計を止める理由にはしない
    const endsAt = parseDate(row.period_end) ?? startsAt;
    const allDay = isAllDay(startsAt, endsAt);
    const spanMs = Math.max(0, endsAt.getTime() - startsAt.getTime());

    meetings.push({
      title: readTitle(row.metrics),
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      minutes: allDay ? 0 : Math.round(spanMs / MINUTE_MS),
      allDay,
      attendeeCount: countAttendees(row.metrics),
    });
  }

  return meetings.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

function sumMinutes(meetings: Meeting[]): number {
  return meetings.reduce((sum, m) => sum + m.minutes, 0);
}

/**
 * 終日予定かどうか（W-1-3）。
 *
 * 取り込み側は Google の `start.date`（日付だけ）をそのまま `period_start` に入れるため、
 * DB からは **UTC 深夜0時ちょうど・丸1日単位**の値として返ってくる。
 * 判定に使える手掛かりはこの形しかない。
 *
 * 「UTC 深夜0時始まり」だけでは足りない。JST 09:00 の会議がちょうど UTC 深夜0時始まりであり、
 * 毎朝の定例が全部終日に化ける。**丸1日の倍数であること**を必ず併せて見る。
 */
function isAllDay(start: Date, end: Date): boolean {
  const span = end.getTime() - start.getTime();
  return start.getTime() % DAY_MS === 0 && span > 0 && span % DAY_MS === 0;
}

/**
 * 前週比を出す。前週が 0 なら比を出さない（W-1-5）。
 *
 * ゼロ除算を避けるためだけでなく、**0% と書かないため**でもある。
 * 呼び出し側は `available: false` を「比較できるだけの履歴がありません」と訳す。
 */
function compare(current: number, previous: number): Comparison {
  if (previous === 0) return { available: false };
  return {
    available: true,
    previous,
    changePercent: Math.round(((current - previous) / previous) * 100),
  };
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function asRecord(metrics: unknown): Record<string, unknown> | null {
  return typeof metrics === "object" && metrics !== null
    ? (metrics as Record<string, unknown>)
    : null;
}

function readTitle(metrics: unknown): string | null {
  const title = asRecord(metrics)?.title;
  if (typeof title !== "string") return null;
  const trimmed = title.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 出席者の**人数だけ**を取り出す（W-1-4 / W-D4）。
 *
 * `metrics.attendees` は S1 の個人データであり、件数以外の用途が無い。
 * この関数が返すのは数であって、呼び出し側が中身に触る経路を作らない。
 * 配列でない・欠けている・null は 0 として扱い、例外にしない。
 */
function countAttendees(metrics: unknown): number {
  const attendees = asRecord(metrics)?.attendees;
  return Array.isArray(attendees) ? attendees.length : 0;
}
