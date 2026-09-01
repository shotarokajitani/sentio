/**
 * `/report` の週フォールバック（契約 `docs/contracts/slice-report-fallback.md`・スライスRF）。
 *
 * `/report` は当週固定（W-D1）、`sync-connections` は `timeMax = now` なので
 * **月曜の朝は構造的に必ず0件**になる。当週が0件のときだけ、
 * 直近の「会議がある週」へ最大8週まで遡る。
 *
 * **陰性コントロールがこのスライスの本体である。**
 * 遡ってはいけない場面（RF-1-1 / RF-1-5 / RF-1-6）で遡らないことを見る。
 * 黙って週をずらす実装は、経営者に「今週の数字」として先週の数字を見せることになる。
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReportView } from "@/app/report/report-view";
import { ja } from "@/i18n/ja";
import {
  FALLBACK_MAX_WEEKS,
  jstWeekRange,
  resolveWeekReference,
  summarizeWeek,
  summarizeWeekWithFallback,
  type EventRow,
} from "@shared/report/weekly";

/** JST の壁時計で書いた時刻を UTC の ISO 文字列にする（フィクスチャを読みやすくするため） */
function jst(iso: string): string {
  return new Date(`${iso}+09:00`).toISOString();
}

/** 実際に事故が起きた時刻（2026-08-31 00:35 JST・月曜の未明） */
const NOW_MONDAY = new Date(jst("2026-08-31T00:35:00"));
/** 週の途中。当週に既に実績がある状況を作るため */
const NOW_WEDNESDAY = new Date(jst("2026-09-02T10:00:00"));

function meeting(startJst: string, endJst: string, attendees = 0): EventRow {
  return {
    source: "google_calendar",
    event_type: "schedule",
    period_start: jst(startJst),
    period_end: jst(endJst),
    metrics: {
      title: "定例",
      attendees: Array.from({ length: attendees }, (_, i) => ({
        email: `attendee-${i}@example.invalid`,
      })),
    },
  };
}

/** 当週 = 2026-08-31(月)〜09-06(日)。以降のフィクスチャはこの週を基準に置く */
const IN_CURRENT_WEEK = meeting("2026-08-31T10:00:00", "2026-08-31T11:00:00");
const IN_WEEK_MINUS_1 = meeting("2026-08-25T14:00:00", "2026-08-25T15:00:00");
const IN_WEEK_MINUS_2 = meeting("2026-08-18T14:00:00", "2026-08-18T15:00:00");
const IN_WEEK_MINUS_3 = meeting("2026-08-11T14:00:00", "2026-08-11T15:00:00");
const IN_WEEK_MINUS_9 = meeting("2026-06-30T14:00:00", "2026-06-30T15:00:00");
const IN_FUTURE_WEEK = meeting("2026-09-08T14:00:00", "2026-09-08T15:00:00");

function weekStartOf(date: Date): string {
  return jstWeekRange(date).start.toISOString();
}

describe("RF-1: 遡る条件（陰性コントロールが本体）", () => {
  it("RF-1-1（陰性コントロール）: 当週に会議があるときは遡らない", () => {
    const rows = [IN_CURRENT_WEEK, IN_WEEK_MINUS_1];
    const summary = summarizeWeekWithFallback(rows, NOW_WEDNESDAY);

    expect(summary.isFallback).toBe(false);
    expect(summary.weekStart).toBe(weekStartOf(NOW_WEDNESDAY));
    // 先週の1件を「今週」として混ぜない
    expect(summary.meetingCount).toBe(1);
  });

  it("RF-1-2: 当週が0件で前週に会議があれば前週を出す", () => {
    const summary = summarizeWeekWithFallback([IN_WEEK_MINUS_1], NOW_MONDAY);

    expect(summary.isFallback).toBe(true);
    expect(summary.weekStart).toBe(weekStartOf(new Date(jst("2026-08-25T00:00:00"))));
    expect(summary.meetingCount).toBe(1);
  });

  it("RF-1-3: 間の空週を飛ばして3週前を出す", () => {
    const summary = summarizeWeekWithFallback([IN_WEEK_MINUS_3], NOW_MONDAY);

    expect(summary.isFallback).toBe(true);
    expect(summary.weekStart).toBe(weekStartOf(new Date(jst("2026-08-11T00:00:00"))));
  });

  it("RF-1-4: 会議がある週が複数あるとき、最も新しい週を選ぶ", () => {
    // 「最初に見つかった週」を古い側から探す実装だと -3 を選んでしまう
    const summary = summarizeWeekWithFallback([IN_WEEK_MINUS_3, IN_WEEK_MINUS_1], NOW_MONDAY);

    expect(summary.weekStart).toBe(weekStartOf(new Date(jst("2026-08-25T00:00:00"))));
    expect(summary.weekStart).not.toBe(weekStartOf(new Date(jst("2026-08-11T00:00:00"))));
  });

  it("RF-1-5（陰性コントロール）: 8週遡っても0件なら当週の空状態を出す", () => {
    // -9 週は上限の外。ここを拾うと「2ヶ月前の週」を今週として見せることになる
    const summary = summarizeWeekWithFallback([IN_WEEK_MINUS_9], NOW_MONDAY);

    expect(summary.isFallback).toBe(false);
    expect(summary.weekStart).toBe(weekStartOf(NOW_MONDAY));
    expect(summary.meetingCount).toBe(0);
  });

  it("RF-1-6（陰性コントロール）: 未来にしか予定が無くても未来の週を選ばない", () => {
    const summary = summarizeWeekWithFallback([IN_FUTURE_WEEK], NOW_MONDAY);

    expect(summary.isFallback).toBe(false);
    expect(summary.weekStart).toBe(weekStartOf(NOW_MONDAY));
    expect(summary.meetingCount).toBe(0);
  });

  it("遡り上限は定数1つで固定されている（設定可能にしない）", () => {
    expect(FALLBACK_MAX_WEEKS).toBe(8);
  });

  it("resolveWeekReference は当週に実績があれば now と同じ時刻を返す", () => {
    // 同一インスタンスかは問わない。**指す時刻が変わっていない**ことが要件である
    expect(resolveWeekReference([IN_CURRENT_WEEK], NOW_WEDNESDAY).getTime()).toBe(
      NOW_WEDNESDAY.getTime(),
    );
  });
});

describe("RF-2: 出す数字が正しい", () => {
  it("RF-2-1: フォールバック時の集計が、その週を直接指定した結果と一致する", () => {
    const rows = [IN_WEEK_MINUS_1, IN_WEEK_MINUS_2];
    const fallback = summarizeWeekWithFallback(rows, NOW_MONDAY);
    const direct = summarizeWeek(rows, new Date(jst("2026-08-25T00:00:00")));

    expect(fallback.meetingCount).toBe(direct.meetingCount);
    expect(fallback.totalMeetingMinutes).toBe(direct.totalMeetingMinutes);
    expect(fallback.totalAttendees).toBe(direct.totalAttendees);
    expect(fallback.weekStart).toBe(direct.weekStart);
  });

  it("RF-2-2: 前週比は「表示している週の前週」と比べる（当週と比べない）", () => {
    // -1 週に2件、-2 週に1件。表示は -1 週なので、比較相手は -2 週の1件
    const rows = [
      IN_WEEK_MINUS_1,
      meeting("2026-08-27T14:00:00", "2026-08-27T15:00:00"),
      IN_WEEK_MINUS_2,
    ];
    const summary = summarizeWeekWithFallback(rows, NOW_MONDAY);

    expect(summary.meetingCount).toBe(2);
    expect(summary.meetingCountChange).toEqual({
      available: true,
      previous: 1,
      changePercent: 100,
    });
  });

  it("RF-2-3: weekStart / weekEnd が表示している週を指す", () => {
    const summary = summarizeWeekWithFallback([IN_WEEK_MINUS_1], NOW_MONDAY);
    const week = jstWeekRange(new Date(jst("2026-08-25T00:00:00")));

    expect(summary.weekStart).toBe(week.start.toISOString());
    expect(summary.weekEnd).toBe(week.end.toISOString());
    expect(summary.weekStart).not.toBe(weekStartOf(NOW_MONDAY));
  });
});

describe("RF-3: 表示側", () => {
  function render(rows: EventRow[], now: Date): string {
    return renderToStaticMarkup(
      createElement(ReportView, { summary: summarizeWeekWithFallback(rows, now) }),
    );
  }

  it("遡ったときは、遡ったことを一文で明示する", () => {
    const html = render([IN_WEEK_MINUS_1], NOW_MONDAY);
    expect(html).toContain(ja.report.fallbackNotice);
  });

  it("RF-1-1（陰性コントロール・表示側）: 遡っていないときはその一文を出さない", () => {
    const html = render([IN_CURRENT_WEEK], NOW_WEDNESDAY);
    expect(html).not.toContain(ja.report.fallbackNotice);
  });

  it("RF-1-5（陰性コントロール・表示側）: 8週遡っても0件なら空状態を出し、遡り文は出さない", () => {
    const html = render([IN_WEEK_MINUS_9], NOW_MONDAY);
    expect(html).toContain(ja.report.emptyTitle);
    expect(html).not.toContain(ja.report.fallbackNotice);
  });

  it("RF-3-1（陰性コントロール）: 遡った週でも出席者のメールアドレスが1文字も出ない", () => {
    const withAttendees = meeting("2026-08-25T14:00:00", "2026-08-25T15:00:00", 3);
    const html = render([withAttendees], NOW_MONDAY);

    // 人数としては数えられている
    expect(html).toContain(ja.report.attendeeCount(3));
    expect(html).not.toContain("@example.invalid");
    expect(html).not.toContain("attendee-");
    expect(html).not.toContain("@");
  });

  it("遡ったときは予定リストの見出しを「この週の予定」にする", () => {
    // 本番実測（2026-08-31）で、遡り表示なのに見出しが「今週の予定」のまま
    // 先週の予定が並んでいた。契約の書き漏れ（追補）
    const html = render([IN_WEEK_MINUS_1], NOW_MONDAY);

    expect(html).toContain(ja.report.fallbackScheduleHeading);
    expect(html).not.toContain(ja.report.scheduleHeading);
  });

  it("陰性コントロール: 遡っていないときは「今週の予定」のままにする", () => {
    // 常に差し替える実装・両方出す実装はここで落ちる
    const html = render([IN_CURRENT_WEEK], NOW_WEDNESDAY);

    expect(html).toContain(ja.report.scheduleHeading);
    expect(html).not.toContain(ja.report.fallbackScheduleHeading);
  });

  it("見出しに「先週」と書かない（遡り先は前週とは限らない・最大8週）", () => {
    // 3週前に遡ったのに「先週の予定」と書くと嘘になる
    const html = render([IN_WEEK_MINUS_3], NOW_MONDAY);

    expect(html).toContain(ja.report.fallbackScheduleHeading);
    expect(html).not.toContain("先週の予定");
  });
});
