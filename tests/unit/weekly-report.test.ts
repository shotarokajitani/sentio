import { describe, it, expect } from "vitest";
import { jstWeekRange, summarizeWeek, type EventRow } from "@shared/report/weekly";

/**
 * 契約 W-1 系 / W-2-1 / W-2-4（`docs/contracts/slice-weekly-report.md`）。
 *
 * 陰性コントロール（W-1-3 / W-1-5 / W-2-1 / W-2-4）を先に置いてある。
 * この4本は「出してはいけないものを出していない」ことの担保であり、
 * 集計が動いているだけでは通らない。
 *
 * **フィクスチャのメールアドレスは実在しない値に固定する**（契約 停止点）。
 * `.invalid` は RFC 2606 で「解決されないこと」が保証された予約TLDである。
 */
const FAKE_ATTENDEE = "nobody@example.invalid";
const FAKE_ATTENDEE_2 = "someone-else@example.invalid";

// 2026-08-28 金曜 09:00 JST。この週の JST 月曜は 2026-08-24
const REFERENCE = new Date("2026-08-28T00:00:00Z");

function meeting(overrides: Partial<EventRow> = {}): EventRow {
  return {
    source: "google_calendar",
    event_type: "schedule",
    period_start: "2026-08-25T01:00:00Z",
    period_end: "2026-08-25T02:00:00Z",
    metrics: { title: "定例", attendees: [FAKE_ATTENDEE] },
    ...overrides,
  };
}

describe("jstWeekRange（W-1-1: 週は JST の月曜00:00〜日曜23:59:59）", () => {
  it("週の始まりは JST 月曜00:00（＝日曜15:00 UTC）", () => {
    const { start } = jstWeekRange(REFERENCE);
    expect(start.toISOString()).toBe("2026-08-23T15:00:00.000Z");
  });

  it("週の終わりは翌 JST 月曜00:00（半開区間の上端）", () => {
    const { end } = jstWeekRange(REFERENCE);
    expect(end.toISOString()).toBe("2026-08-30T15:00:00.000Z");
  });

  it("JST 月曜00:00ちょうどを基準にしても、その週の始まりはその瞬間になる", () => {
    const { start } = jstWeekRange(new Date("2026-08-23T15:00:00Z"));
    expect(start.toISOString()).toBe("2026-08-23T15:00:00.000Z");
  });

  it("JST 日曜23:59:59 を基準にすると、直前の月曜が週の始まりになる", () => {
    const { start } = jstWeekRange(new Date("2026-08-30T14:59:59Z"));
    expect(start.toISOString()).toBe("2026-08-23T15:00:00.000Z");
  });
});

describe("summarizeWeek — W-1-2: 会議件数", () => {
  it("その週に period_start が入る schedule の件数を数える", () => {
    const summary = summarizeWeek(
      [
        meeting({ period_start: "2026-08-24T01:00:00Z", period_end: "2026-08-24T02:00:00Z" }),
        meeting({ period_start: "2026-08-26T01:00:00Z", period_end: "2026-08-26T02:00:00Z" }),
      ],
      REFERENCE,
    );
    expect(summary.meetingCount).toBe(2);
  });

  it("週の外（前週・翌週）の予定は当週の件数に入らない", () => {
    const summary = summarizeWeek(
      [
        meeting({ period_start: "2026-08-23T14:59:59Z", period_end: "2026-08-23T15:59:59Z" }),
        meeting({ period_start: "2026-08-30T15:00:00Z", period_end: "2026-08-30T16:00:00Z" }),
      ],
      REFERENCE,
    );
    expect(summary.meetingCount).toBe(0);
  });

  it("UTC で切らない: JST 月曜02:00（UTC では日曜）の予定は当週に入る", () => {
    // 2026-08-24 02:00 JST = 2026-08-23T17:00:00Z（UTC では日曜）。
    // UTC の週で切ると前週に落ちる。JST で切れば当週である
    const summary = summarizeWeek(
      [meeting({ period_start: "2026-08-23T17:00:00Z", period_end: "2026-08-23T18:00:00Z" })],
      REFERENCE,
    );
    expect(summary.meetingCount).toBe(1);
  });

  it("event_type が schedule でない行は数えない", () => {
    const summary = summarizeWeek([meeting({ event_type: "transaction" })], REFERENCE);
    expect(summary.meetingCount).toBe(0);
  });

  it("period_start が無い行は例外にせず落とす", () => {
    const summary = summarizeWeek([meeting({ period_start: null })], REFERENCE);
    expect(summary.meetingCount).toBe(0);
  });
});

describe("summarizeWeek — W-2-4 陰性コントロール: source の絞り込み", () => {
  it("google_calendar 以外の source は会議として数えない", () => {
    const summary = summarizeWeek(
      [
        meeting({ source: "freee" }),
        meeting({ source: "csv:accounting" }),
        meeting({ source: null }),
      ],
      REFERENCE,
    );
    expect(summary.meetingCount).toBe(0);
    expect(summary.totalMeetingMinutes).toBe(0);
    expect(summary.meetings).toHaveLength(0);
  });

  it("google_calendar の行だけが残る（混在させても他 source を拾わない）", () => {
    const summary = summarizeWeek(
      [meeting(), meeting({ source: "freee" }), meeting({ source: "kingoftime" })],
      REFERENCE,
    );
    expect(summary.meetingCount).toBe(1);
  });
});

describe("summarizeWeek — W-1-3 陰性コントロール: 終日予定を総会議時間に混ぜない", () => {
  // 終日予定は Google が `date`（日付だけ）で返し、取り込み側がそのまま入れる。
  // DB は UTC 深夜0時ちょうどの timestamptz として返す（両端が UTC 00:00 で丸1日単位）
  const allDay = meeting({
    period_start: "2026-08-25T00:00:00Z",
    period_end: "2026-08-26T00:00:00Z",
    metrics: { title: "終日: 出張", attendees: [] },
  });

  it("終日予定の24時間は総会議時間に加算されない", () => {
    const summary = summarizeWeek([allDay], REFERENCE);
    expect(summary.totalMeetingMinutes).toBe(0);
  });

  it("終日予定は別枠（allDayCount）で数える", () => {
    const summary = summarizeWeek([allDay], REFERENCE);
    expect(summary.allDayCount).toBe(1);
  });

  it("時間指定の会議と混ざっても、総会議時間は時間指定分だけになる", () => {
    const summary = summarizeWeek(
      [
        allDay,
        meeting({ period_start: "2026-08-25T01:00:00Z", period_end: "2026-08-25T02:30:00Z" }),
      ],
      REFERENCE,
    );
    expect(summary.totalMeetingMinutes).toBe(90);
    expect(summary.allDayCount).toBe(1);
  });

  it("複数日にまたがる終日予定も総会議時間に入らない", () => {
    const summary = summarizeWeek(
      [
        meeting({
          period_start: "2026-08-24T00:00:00Z",
          period_end: "2026-08-27T00:00:00Z",
          metrics: { title: "終日: 合宿", attendees: [] },
        }),
      ],
      REFERENCE,
    );
    expect(summary.totalMeetingMinutes).toBe(0);
    expect(summary.allDayCount).toBe(1);
  });

  it("陽性コントロール: UTC 深夜0時に始まっても24時間の倍数でなければ終日ではない", () => {
    // 2026-08-25 09:00 JST = 2026-08-25T00:00:00Z 始まりの1時間の会議。
    // 「UTC 深夜0時始まり」だけを終日の判定に使うと、これを取りこぼす
    const summary = summarizeWeek(
      [meeting({ period_start: "2026-08-25T00:00:00Z", period_end: "2026-08-25T01:00:00Z" })],
      REFERENCE,
    );
    expect(summary.allDayCount).toBe(0);
    expect(summary.totalMeetingMinutes).toBe(60);
  });
});

describe("summarizeWeek — W-1-4: 出席者数", () => {
  it("metrics.attendees の要素数を数える", () => {
    const summary = summarizeWeek(
      [meeting({ metrics: { title: "定例", attendees: [FAKE_ATTENDEE, FAKE_ATTENDEE_2] } })],
      REFERENCE,
    );
    expect(summary.meetings[0].attendeeCount).toBe(2);
    expect(summary.totalAttendees).toBe(2);
  });

  it("attendees が null でも 0 として扱い、例外にしない", () => {
    const summary = summarizeWeek(
      [meeting({ metrics: { title: "定例", attendees: null } })],
      REFERENCE,
    );
    expect(summary.meetings[0].attendeeCount).toBe(0);
  });

  it("attendees のキーごと無くても 0 として扱う", () => {
    const summary = summarizeWeek([meeting({ metrics: { title: "定例" } })], REFERENCE);
    expect(summary.meetings[0].attendeeCount).toBe(0);
  });

  it("metrics 自体が null でも 0 として扱い、例外にしない", () => {
    const summary = summarizeWeek([meeting({ metrics: null })], REFERENCE);
    expect(summary.meetings[0].attendeeCount).toBe(0);
    expect(summary.meetingCount).toBe(1);
  });

  it("attendees が配列でない型（文字列）でも 0 として扱う", () => {
    const summary = summarizeWeek(
      [meeting({ metrics: { title: "定例", attendees: FAKE_ATTENDEE } })],
      REFERENCE,
    );
    expect(summary.meetings[0].attendeeCount).toBe(0);
  });
});

describe("summarizeWeek — W-1-5 陰性コントロール: 前週0件のときに比を出さない", () => {
  it("前週が0件なら available:false を返す（ゼロ除算しない）", () => {
    const summary = summarizeWeek(
      [meeting({ period_start: "2026-08-25T01:00:00Z", period_end: "2026-08-25T02:00:00Z" })],
      REFERENCE,
    );
    expect(summary.meetingCountChange.available).toBe(false);
  });

  it("前週が0件のとき、増減率のキーに 0 が入らない", () => {
    const summary = summarizeWeek([meeting()], REFERENCE);
    // 「0%」を出す実装は、この検査で落ちる
    expect(JSON.stringify(summary.meetingCountChange)).not.toContain("changePercent");
  });

  it("当週も前週も0件でも available:false（NaN を出さない）", () => {
    const summary = summarizeWeek([], REFERENCE);
    expect(summary.meetingCountChange).toEqual({ available: false });
    expect(summary.meetingMinutesChange).toEqual({ available: false });
  });

  it("前週の総会議時間が0分なら、時間の増減率も出さない（終日だけの週）", () => {
    const summary = summarizeWeek(
      [
        // 前週は終日予定だけ＝件数は1だが総会議時間は0分
        meeting({
          period_start: "2026-08-18T00:00:00Z",
          period_end: "2026-08-19T00:00:00Z",
          metrics: { title: "終日: 休業", attendees: [] },
        }),
        meeting({ period_start: "2026-08-25T01:00:00Z", period_end: "2026-08-25T02:00:00Z" }),
      ],
      REFERENCE,
    );
    expect(summary.meetingCountChange.available).toBe(true);
    expect(summary.meetingMinutesChange).toEqual({ available: false });
  });
});

describe("summarizeWeek — W-D3: 前週比", () => {
  const rows: EventRow[] = [
    // 前週（JST 2026-08-17〜08-23）に2件・計120分
    meeting({ period_start: "2026-08-18T01:00:00Z", period_end: "2026-08-18T02:00:00Z" }),
    meeting({ period_start: "2026-08-19T01:00:00Z", period_end: "2026-08-19T02:00:00Z" }),
    // 当週（JST 2026-08-24〜08-30）に3件・計180分
    meeting({ period_start: "2026-08-24T01:00:00Z", period_end: "2026-08-24T02:00:00Z" }),
    meeting({ period_start: "2026-08-25T01:00:00Z", period_end: "2026-08-25T02:00:00Z" }),
    meeting({ period_start: "2026-08-26T01:00:00Z", period_end: "2026-08-26T02:00:00Z" }),
  ];

  it("前週に実績があるときは増減率を返す", () => {
    const summary = summarizeWeek(rows, REFERENCE);
    expect(summary.meetingCountChange).toEqual({
      available: true,
      previous: 2,
      changePercent: 50,
    });
  });

  it("総会議時間の増減率も同じ計算で出す", () => {
    const summary = summarizeWeek(rows, REFERENCE);
    expect(summary.meetingMinutesChange).toEqual({
      available: true,
      previous: 120,
      changePercent: 50,
    });
  });

  it("減っているときは負の値になる", () => {
    const summary = summarizeWeek(
      [
        meeting({ period_start: "2026-08-18T01:00:00Z", period_end: "2026-08-18T02:00:00Z" }),
        meeting({ period_start: "2026-08-19T01:00:00Z", period_end: "2026-08-19T02:00:00Z" }),
        meeting({ period_start: "2026-08-20T01:00:00Z", period_end: "2026-08-20T02:00:00Z" }),
        meeting({ period_start: "2026-08-24T01:00:00Z", period_end: "2026-08-24T02:00:00Z" }),
      ],
      REFERENCE,
    );
    expect(summary.meetingCountChange).toEqual({
      available: true,
      previous: 3,
      changePercent: -67,
    });
  });

  it("前週の境界（JST 月曜00:00 の直前）は前週として数える", () => {
    const summary = summarizeWeek(
      [
        meeting({ period_start: "2026-08-23T14:59:59Z", period_end: "2026-08-23T15:59:59Z" }),
        meeting({ period_start: "2026-08-24T01:00:00Z", period_end: "2026-08-24T02:00:00Z" }),
      ],
      REFERENCE,
    );
    expect(summary.meetingCountChange.available).toBe(true);
    if (summary.meetingCountChange.available) {
      expect(summary.meetingCountChange.previous).toBe(1);
    }
  });

  it("前々週より前の行は前週にも当週にも入らない", () => {
    const summary = summarizeWeek(
      [meeting({ period_start: "2026-08-10T01:00:00Z", period_end: "2026-08-10T02:00:00Z" })],
      REFERENCE,
    );
    expect(summary.meetingCount).toBe(0);
    expect(summary.meetingCountChange).toEqual({ available: false });
  });
});

describe("summarizeWeek — W-2-1 陰性コントロール: 出席者のメールアドレスを出力に載せない", () => {
  it("出力のどこにも出席者のメールアドレスが現れない", () => {
    const summary = summarizeWeek(
      [
        meeting({ metrics: { title: "定例", attendees: [FAKE_ATTENDEE, FAKE_ATTENDEE_2] } }),
        meeting({
          period_start: "2026-08-26T01:00:00Z",
          period_end: "2026-08-26T02:00:00Z",
          metrics: { title: "商談", attendees: [FAKE_ATTENDEE] },
        }),
      ],
      REFERENCE,
    );

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(FAKE_ATTENDEE);
    expect(serialized).not.toContain(FAKE_ATTENDEE_2);
    // ドメインもローカル部も、部分文字列として残っていないこと
    expect(serialized).not.toContain("example.invalid");
    expect(serialized).not.toContain("nobody");
    // 数だけは残る（W-1-4）
    expect(summary.totalAttendees).toBe(3);
  });

  it("attendees をそのまま持つキーが出力に存在しない", () => {
    const summary = summarizeWeek([meeting()], REFERENCE);
    expect(JSON.stringify(summary)).not.toContain("attendees");
  });
});

describe("summarizeWeek — W-D5: 件名は出す", () => {
  it("metrics.title を会議の件名として返す", () => {
    const summary = summarizeWeek([meeting({ metrics: { title: "四半期レビュー" } })], REFERENCE);
    expect(summary.meetings[0].title).toBe("四半期レビュー");
  });

  it("件名が無い・空のときは null を返す（表示側で言い換える）", () => {
    const summary = summarizeWeek(
      [meeting({ metrics: { attendees: [] } }), meeting({ metrics: { title: "  " } })],
      REFERENCE,
    );
    expect(summary.meetings[0].title).toBeNull();
    expect(summary.meetings[1].title).toBeNull();
  });

  it("件名が文字列でないときも null にする（生の値を通さない）", () => {
    const summary = summarizeWeek([meeting({ metrics: { title: 42 } })], REFERENCE);
    expect(summary.meetings[0].title).toBeNull();
  });

  it("会議は開始の早い順に並ぶ", () => {
    const summary = summarizeWeek(
      [
        meeting({
          period_start: "2026-08-26T01:00:00Z",
          period_end: "2026-08-26T02:00:00Z",
          metrics: { title: "あと" },
        }),
        meeting({
          period_start: "2026-08-24T01:00:00Z",
          period_end: "2026-08-24T02:00:00Z",
          metrics: { title: "さき" },
        }),
      ],
      REFERENCE,
    );
    expect(summary.meetings.map((m) => m.title)).toEqual(["さき", "あと"]);
  });
});

describe("summarizeWeek — 壊れた行を例外にしない", () => {
  it("period_end が無い会議は0分として扱う（件数には入る）", () => {
    const summary = summarizeWeek([meeting({ period_end: null })], REFERENCE);
    expect(summary.meetingCount).toBe(1);
    expect(summary.meetings[0].minutes).toBe(0);
  });

  it("period_end が period_start より前でも負の時間にならない", () => {
    const summary = summarizeWeek(
      [meeting({ period_start: "2026-08-25T02:00:00Z", period_end: "2026-08-25T01:00:00Z" })],
      REFERENCE,
    );
    expect(summary.totalMeetingMinutes).toBe(0);
  });

  it("日付として読めない period_start は落とす", () => {
    const summary = summarizeWeek([meeting({ period_start: "not-a-date" })], REFERENCE);
    expect(summary.meetingCount).toBe(0);
  });

  it("週の範囲は出力にも載る（表示が UTC で切り直さないため）", () => {
    const summary = summarizeWeek([], REFERENCE);
    expect(summary.weekStart).toBe("2026-08-23T15:00:00.000Z");
    expect(summary.weekEnd).toBe("2026-08-30T15:00:00.000Z");
  });
});
