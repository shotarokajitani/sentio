/**
 * 週次メールの本文組み立て（契約 `docs/contracts/slice-weekly-mail.md`・スライスWM）。
 *
 * **WM-1-2 が中心。** 同じ `events` を画面側（`summarizeWeek`）とメール側
 * （`buildWeeklySections`）の両方に流し、出てくる数字が一致することを見る。
 * 画面とメールが違うことを言い出したら、このテストが落ちる。
 */

import { describe, it, expect } from "vitest";
import { summarizeWeek, type EventRow } from "@shared/report/weekly";
import { buildWeeklySections, weekReference, NO_COMPARISON } from "@edge/_shared/weekly-sections";
import { isoWeekKey } from "@edge/_shared/jst";
import { deliveryKey } from "@edge/_shared/delivery";
import { renderWeeklyHtml, renderWeeklyText } from "@edge/_shared/email-html";

/** JST の壁時計で書いた時刻を UTC の ISO 文字列にする（フィクスチャを読みやすくするためだけ） */
function jst(iso: string): string {
  return new Date(`${iso}+09:00`).toISOString();
}

/**
 * 出席者は**人数だけ**が意味を持つ（WM-2-1）。
 * 実在しないアドレスを使う（契約 停止点）。本文に出ないことをテストが確かめる。
 */
function attendees(n: number): { email: string }[] {
  return Array.from({ length: n }, (_, i) => ({ email: `attendee-${i}@example.invalid` }));
}

function meeting(
  title: string,
  startJst: string,
  endJst: string,
  attendeeCount = 0,
): EventRow {
  return {
    source: "google_calendar",
    event_type: "schedule",
    period_start: jst(startJst),
    period_end: jst(endJst),
    metrics: { title, attendees: attendees(attendeeCount) },
  };
}

/** 本番で実測した週（2026-08-24〜30）と同じ形。60+90+30+60+60 = 300分 */
const PRODUCTION_WEEK: EventRow[] = [
  meeting("週次経営会議", "2026-08-24T10:00:00", "2026-08-24T11:00:00"),
  meeting("新規パートナー商談（初回）", "2026-08-25T14:00:00", "2026-08-25T15:30:00"),
  meeting("開発デイリー", "2026-08-26T09:30:00", "2026-08-26T10:00:00"),
  meeting("顧客定例 — 導入レビュー", "2026-08-27T13:00:00", "2026-08-27T14:00:00"),
  meeting("採用面談（1次）", "2026-08-28T16:00:00", "2026-08-28T17:00:00", 3),
];

const REFERENCE = new Date(jst("2026-08-26T12:00:00"));

function baseInput() {
  return {
    findings: [],
    activeProviders: ["google_calendar"],
    csvCount: 0,
    calCount: PRODUCTION_WEEK.length,
  };
}

function sectionContent(sections: { type: string; content: string }[], type: string): string {
  const found = sections.find((s) => s.type === type);
  if (!found) throw new Error(`section が無い: ${type}`);
  return found.content;
}

/** 本文に出た「X時間Y分」を分に戻す。画面側の数字と突き合わせるため */
function minutesFromText(text: string): number | null {
  const hm = /(\d+)時間(\d+)分/.exec(text);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  const h = /(\d+)時間/.exec(text);
  if (h) return Number(h[1]) * 60;
  const m = /(\d+)分/.exec(text);
  return m ? Number(m[1]) : null;
}

describe("週次メールの本文（スライスWM）", () => {
  it("WM-1-2: 画面側 summarizeWeek と同じ数字がメール本文に出る", () => {
    const summary = summarizeWeek(PRODUCTION_WEEK, REFERENCE);
    const sections = buildWeeklySections({ summary, ...baseInput() });
    const digest = sectionContent(sections, "digest");

    // 画面側の実測値と同じであることを、まず固定値で押さえる
    expect(summary.meetingCount).toBe(5);
    expect(summary.totalMeetingMinutes).toBe(300);
    expect(summary.totalAttendees).toBe(3);

    // メール本文から数字を読み戻し、画面側の値と突き合わせる
    expect(/会議\s*(\d+)\s*件/.exec(digest)?.[1]).toBe(String(summary.meetingCount));
    expect(minutesFromText(digest)).toBe(summary.totalMeetingMinutes);
    expect(/のべ出席者\s*(\d+)\s*人/.exec(digest)?.[1]).toBe(String(summary.totalAttendees));
  });

  it("WM-1-1: 会議件数・総会議時間・のべ出席者の3つが本文に入る", () => {
    const summary = summarizeWeek(PRODUCTION_WEEK, REFERENCE);
    const digest = sectionContent(buildWeeklySections({ summary, ...baseInput() }), "digest");

    expect(digest).toMatch(/会議\s*5\s*件/);
    expect(digest).toContain("5時間");
    expect(digest).toMatch(/のべ出席者\s*3\s*人/);
  });

  it("WM-1-3: 当週0件のときは予定が無いことを言う。基準値の文言で埋めない", () => {
    const summary = summarizeWeek([], REFERENCE);
    const sections = buildWeeklySections({
      summary,
      ...baseInput(),
      calCount: 0,
    });
    const digest = sectionContent(sections, "digest");

    expect(summary.meetingCount).toBe(0);
    expect(digest).toContain("予定がありません");
    // これがこのスライスで潰す穴そのもの
    expect(digest).not.toContain("基準値はデータ蓄積後に確立されます");
    for (const s of sections) {
      expect(s.content).not.toContain("基準値はデータ蓄積後に確立されます");
    }
  });

  it("WM-1-4（陰性コントロール）: 前週が0件なら増減率を出さない。0% と書かない", () => {
    // PRODUCTION_WEEK は当週だけ。前週は1件も無い
    const summary = summarizeWeek(PRODUCTION_WEEK, REFERENCE);
    expect(summary.meetingCountChange.available).toBe(false);

    const sections = buildWeeklySections({ summary, ...baseInput() });
    for (const s of sections) {
      expect(s.content).not.toContain("%");
      expect(s.content).not.toContain("0%");
    }
    expect(sectionContent(sections, "digest")).toContain(NO_COMPARISON);
  });

  it("WM-1-4（陽性コントロール）: 前週に実績があれば増減率を出す", () => {
    // 前週（8/17-23）に2件置く。これが無いと「常に出さない」実装でも陰性側が通ってしまう
    const withPrevious: EventRow[] = [
      ...PRODUCTION_WEEK,
      meeting("前週の定例A", "2026-08-18T10:00:00", "2026-08-18T11:00:00"),
      meeting("前週の定例B", "2026-08-20T10:00:00", "2026-08-20T11:00:00"),
    ];
    const summary = summarizeWeek(withPrevious, REFERENCE);
    expect(summary.meetingCountChange.available).toBe(true);

    const digest = sectionContent(buildWeeklySections({ summary, ...baseInput() }), "digest");
    expect(digest).toContain("%");
    expect(digest).not.toContain(NO_COMPARISON);
  });

  it("落とし穴2: weekReference は ISO週キーと往復する（target_week の週の数字が出る）", () => {
    for (const period of ["2026-W01", "2026-W35", "2026-W53", "2025-W01", "2027-W52"]) {
      const reference = weekReference(period);
      expect(isoWeekKey(reference)).toBe(period);
    }
  });

  it("落とし穴2: target_week を渡すと、その週の数字が入る（new Date() の週にならない）", () => {
    // PRODUCTION_WEEK は 2026-W35。別の週を指定したら0件になるはず
    const summary35 = summarizeWeek(PRODUCTION_WEEK, weekReference("2026-W35"));
    const summary36 = summarizeWeek(PRODUCTION_WEEK, weekReference("2026-W36"));

    expect(summary35.meetingCount).toBe(5);
    expect(summary36.meetingCount).toBe(0);
  });

  it("実装順2: stable_coverage も events 由来にする（baselines の文言で埋めない）", () => {
    const summary = summarizeWeek(PRODUCTION_WEEK, REFERENCE);
    const coverage = sectionContent(
      buildWeeklySections({ summary, ...baseInput() }),
      "stable_coverage",
    );

    expect(coverage).not.toBe("");
    expect(coverage).not.toContain("基準値はデータ蓄積後に確立されます");
    // 終日の内訳は events からしか出せない数字である
    expect(coverage).toMatch(/終日\s*0\s*件/);
  });

  it("WM-2-1（陰性コントロール）: 出席者のメールアドレスが HTML / text の両方に1文字も出ない", () => {
    const summary = summarizeWeek(PRODUCTION_WEEK, REFERENCE);
    const sections = buildWeeklySections({ summary, ...baseInput() });
    const html = renderWeeklyHtml(sections);
    const text = renderWeeklyText(sections);

    // フィクスチャには 3件のアドレスが入っている（人数として数えられているだけ）
    expect(summary.totalAttendees).toBe(3);
    for (const body of [html, text]) {
      expect(body).not.toContain("@example.invalid");
      expect(body).not.toContain("attendee-");
      expect(body).not.toContain("@");
    }
  });

  it("WM-2-2（陰性コントロール）: 会議の件名が本文に出ない（WM-D3）", () => {
    const summary = summarizeWeek(PRODUCTION_WEEK, REFERENCE);
    const sections = buildWeeklySections({ summary, ...baseInput() });
    const html = renderWeeklyHtml(sections);
    const text = renderWeeklyText(sections);

    // 集計側は件名を持っている。持っていることを確かめたうえで、出ないことを見る
    expect(summary.meetings.map((m) => m.title)).toContain("採用面談（1次）");
    for (const title of PRODUCTION_WEEK.map((r) => (r.metrics as { title: string }).title)) {
      expect(html).not.toContain(title);
      expect(text).not.toContain(title);
    }
  });

  it("WM-3-1: 冪等キーは weekly:<company_id>:<ISO週> のまま変わらない", () => {
    const key = deliveryKey({ kind: "weekly", companyId: "c0ffee00-0000-4000-8000-000000000001", period: "2026-W35" });
    expect(key).toBe("weekly:c0ffee00-0000-4000-8000-000000000001:2026-W35");
    // 同じ週なら同じキー＝2回叩いても2通にならない
    expect(deliveryKey({ kind: "weekly", companyId: "c0ffee00-0000-4000-8000-000000000001", period: "2026-W35" })).toBe(key);
  });
});
