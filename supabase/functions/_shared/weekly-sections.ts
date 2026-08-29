/**
 * 週次メールの本文組み立て（契約 `docs/contracts/slice-weekly-mail.md`・スライスWM）。
 *
 * **画面（`/report`）と同じ集計を使う。** 数字の出所は `shared/report/weekly.ts` の
 * `summarizeWeek` ひとつであり、この関数は**それを日本語にするだけ**である。
 * メール側で数え直さないので、画面とメールが違うことを言い出す経路が無い（WM-1-2）。
 *
 * `baselines` は読まない（WM-D2）。`is_established: false` /
 * `observation_count: 0` のままなので、読んでも「基準値はデータ蓄積後に確立されます」
 * しか出せなかった。それがこのスライスで潰す穴である。
 *
 * **会議の件名と出席者のメールアドレスはここから外に出さない**（WM-D3 / WM-2-1）。
 * `WeeklySummary` は件名を持っているが、この関数は数だけを読む。
 */

import type { WeeklySummary, Comparison } from "../../../shared/report/weekly.ts";

export interface WeeklySection {
  type: string;
  content: string;
}

export interface FindingRow {
  what: string;
  status: string;
}

export interface WeeklySectionsInput {
  /** 画面と同じ `summarizeWeek` の出力。メール側で数え直さない */
  summary: WeeklySummary;
  findings: FindingRow[];
  activeProviders: string[];
  csvCount: number;
  calCount: number;
}

/** 前週の実績が無いときの言い方。**`0%` と書かない**（WM-1-4 / WM-D5）。
 * 「変わらなかった」と「比べる相手がいない」は別のことである */
export const NO_COMPARISON = "比較できるだけの履歴がありません";

/** 当週に予定が1件も無いとき。**「基準値はデータ蓄積後に確立されます」で埋めない**（WM-1-3） */
export const EMPTY_WEEK = "今週は会議の予定がありませんでした";

const DAY_MS = 86_400_000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * ISO週キー（`YYYY-Www`）→ その週に属する時刻（落とし穴2）。
 *
 * `summarizeWeek` は `reference: Date` を取る。`target_week` が指定されたときに
 * `new Date()` を渡すと**指定した週と違う週の数字**が本文に入る。
 * 対象期間から基準時刻を導くことで、本文の数字が必ず件名の週と一致する。
 *
 * 返すのは JST 月曜の正午。境界のちょうど上を避けて週の内側に確実に落とす。
 */
export function weekReference(period: string): Date {
  const m = /^(\d{4})-W(\d{2})$/.exec(period);
  if (!m) throw new Error(`ISO週の形式ではない: ${period}`);
  const year = Number(m[1]);
  const week = Number(m[2]);

  // ISO 8601: 第1週は1月4日を含む週である
  const jan4 = Date.UTC(year, 0, 4);
  const sinceMonday = (new Date(jan4).getUTCDay() + 6) % 7;
  const week1Monday = jan4 - sinceMonday * DAY_MS;
  const mondayWallClock = week1Monday + (week - 1) * 7 * DAY_MS;

  // 壁時計を JST として読み直し、正午に寄せる
  return new Date(mondayWallClock - JST_OFFSET_MS + 12 * 60 * 60 * 1000);
}

/** 画面の `duration()` と同じ規則。分だけ・時間だけ・混在の3通り */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}分`;
  return m === 0 ? `${h}時間` : `${h}時間${m}分`;
}

function sourceSummary(input: WeeklySectionsInput): string {
  const sources: string[] = [];
  if (input.activeProviders.includes("google_calendar")) {
    sources.push(`カレンダー(${input.calCount}件)`);
  }
  if (input.csvCount > 0) sources.push(`会計CSV(暫定集計・${input.csvCount}件)`);
  if (input.activeProviders.includes("freee")) sources.push("freee会計");
  return sources.length > 0
    ? `データソース: ${sources.join("、")}。`
    : "データソース: まだ接続されていません。";
}

/** 前週比。比べる相手がいないときは比を出さない（WM-1-4） */
function comparisonText(label: string, change: Comparison): string {
  if (!change.available) return NO_COMPARISON;
  const sign = change.changePercent > 0 ? "+" : "";
  return `${label}は前週比 ${sign}${change.changePercent}%`;
}

function digestContent(input: WeeklySectionsInput): string {
  const { summary } = input;
  if (summary.meetingCount === 0) {
    return `${EMPTY_WEEK}。${sourceSummary(input)}`;
  }

  return (
    `今週の会議 ${summary.meetingCount}件、` +
    `総会議時間 ${formatDuration(summary.totalMeetingMinutes)}、` +
    `のべ出席者 ${summary.totalAttendees}人。` +
    `${comparisonText("会議件数", summary.meetingCountChange)}。` +
    sourceSummary(input)
  );
}

export function buildWeeklySections(input: WeeklySectionsInput): WeeklySection[] {
  const { summary, findings } = input;
  const topFindings = findings.slice(0, 2);

  return [
    { type: "digest", content: digestContent(input) },
    {
      type: "finding",
      content: topFindings.length > 0 ? topFindings.map((f) => `- ${f.what}`).join("\n") : "",
    },
    {
      type: "followup",
      content:
        findings
          .filter((f) => f.status === "watching")
          .map((f) => `- 経過観察中: ${f.what}`)
          .join("\n") || "",
    },
    {
      type: "stable_coverage",
      content:
        summary.meetingCount === 0
          ? `${sourceSummary(input)}集計できる予定がまだありません。`
          : `${sourceSummary(input)}うち終日 ${summary.allDayCount}件。` +
            `${comparisonText("総会議時間", summary.meetingMinutesChange)}。`,
    },
    {
      type: "nudge",
      content: input.activeProviders.includes("google_calendar")
        ? ""
        : "Google カレンダーを接続すると、今週の会議の量が見えるようになります。",
    },
  ];
}
