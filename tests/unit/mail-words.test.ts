/**
 * 顧客に見せる面から内部の語を排除する（発注 ③-7）。
 *
 * ## 何が起きていたか
 *
 * 週次メールの見出しは「今週のFinding」「状態ダイジェスト」だった。
 * **どちらも作り手の語で、受け取る経営者の語ではない。**
 * 「Finding」が何かを知っているのは我々だけで、読んだ人は
 * **自社の状態ではなく、道具の都合を読まされる。**
 *
 * 語を1つ混ぜるだけで、そのメールは「システムからの通知」になる。
 * 体裁の問題ではなく、**製品が何を届けているかの問題**である。
 */
import { describe, it, expect } from "vitest";
import {
  FORBIDDEN_WORDS,
  findForbiddenWords,
  formatMonthDay,
  formatMonthDayWeekday,
  pulseSubject,
  weeklySubject,
} from "@edge/_shared/mail-words";
import { buildWeeklySections } from "@edge/_shared/weekly-sections";
import { renderWeeklyText } from "@edge/_shared/email-html";
import { summarizeWeek, type EventRow } from "@shared/report/weekly";

const REFERENCE = new Date("2026-08-26T03:00:00Z");

function meeting(title: string, startJst: string, endJst: string): EventRow {
  return {
    source: "google_calendar",
    event_type: "schedule",
    period_start: new Date(`${startJst}+09:00`).toISOString(),
    period_end: new Date(`${endJst}+09:00`).toISOString(),
    metrics: { title, attendees: [] },
  };
}

const WEEK: EventRow[] = [
  meeting("週次経営会議", "2026-08-24T10:00:00", "2026-08-24T11:00:00"),
  meeting("採用面談（1次）", "2026-08-28T16:00:00", "2026-08-28T17:00:00"),
];

describe("禁止語の走査", () => {
  it("何も混ざっていなければ0件", () => {
    expect(findForbiddenWords("会議は5件・300分で、前週と同じ量でした。")).toEqual([]);
  });

  it("**陰性**: 禁止語を1つ入れると検出する", () => {
    // ここは検査器自身の陽性確認。実物のメールに対する陰性は下の節で見る
    expect(findForbiddenWords("今週のFindingは2件です")).toContain("Finding");
    expect(findForbiddenWords("状態ダイジェスト")).toContain("ダイジェスト");
  });

  it("英字は大文字小文字を区別しない", () => {
    expect(findForbiddenWords("FINDING が出ました")).toContain("Finding");
    expect(findForbiddenWords("event_type=transaction")).toContain("transaction");
  });

  it("止める語に、作り手だけが知っている語が入っている", () => {
    for (const word of ["Finding", "パケット", "系列", "ダイジェスト", "走査", "ベースライン"]) {
      expect(FORBIDDEN_WORDS as readonly string[], word).toContain(word);
    }
  });
});

describe("週次メールの本文に内部の語が出ない", () => {
  const summary = summarizeWeek(WEEK, REFERENCE);
  const sections = buildWeeklySections({
    summary,
    findings: [],
    activeProviders: ["google_calendar"],
    csvCount: 0,
    calCount: WEEK.length,
  });
  const text = renderWeeklyText(sections, { period: "8月24日〜8月30日" });

  it("見出しが日本語になっている（作り手の語ではない）", () => {
    expect(text).toContain("■ 先週の要約");
    expect(text).toContain("■ 前週からの変化");
    expect(text).toContain("■ 取引先の動き");
    expect(text).toContain("■ 主要指標と時間の使い方");
  });

  it("**陰性**: 本文に禁止語が1つも出ない", () => {
    const hits = findForbiddenWords(text);
    expect(hits, `禁止語が混ざっている: ${hits.join(", ")}`).toEqual([]);
  });

  it("0件の週も「前週からの変化」の節を消さない", () => {
    // 見出しごと消えると「何も見ていない」のか「見たが何も無かった」のかが区別できない
    expect(text).toContain("前週から変わった動きはありませんでした。");
  });

  it("末尾のひと押しは見出しを立てない", () => {
    const withoutCalendar = buildWeeklySections({
      summary,
      findings: [],
      activeProviders: [],
      csvCount: 0,
      calCount: 0,
    });
    const body = renderWeeklyText(withoutCalendar);
    const lines = body.split("\n");
    const at = lines.findIndex((l) => l.includes("Google カレンダーをつなぐと"));
    expect(at).toBeGreaterThan(-1);
    // **ひと押しの直前に見出しが立たない。** 立てると節が1つ増えて見える
    const before =
      lines
        .slice(0, at)
        .reverse()
        .find((l) => l.trim().length > 0) ?? "";
    expect(before.startsWith("■ ")).toBe(false);
  });

  it("初回だけ冒頭に1行入る（7日目の追伸と対になっている）", () => {
    const first = renderWeeklyText(sections, { firstTime: true });
    expect(first).toContain("初めての「今週の会社」です。毎週月曜の朝に届きます。");
    expect(renderWeeklyText(sections)).not.toContain("初めての「今週の会社」です");
  });
});

describe("件名", () => {
  const day = new Date("2026-09-10T00:00:00Z"); // JST 9月10日・木

  it("毎朝は日付と曜日を出す（毎日届くので日付だけでは見分けが付かない）", () => {
    expect(pulseSubject(day)).toBe("【Sentio】今日の会社（9月10日・木）");
  });

  it("週次は期間を出す", () => {
    const from = new Date("2026-09-01T00:00:00Z");
    const to = new Date("2026-09-07T00:00:00Z");
    expect(weeklySubject(from, to)).toBe("【Sentio】今週の会社（9月1日〜9月7日）");
  });

  it("**陰性**: 件名に禁止語が入らない", () => {
    expect(findForbiddenWords(pulseSubject(day))).toEqual([]);
    expect(findForbiddenWords(weeklySubject(new Date("2026-09-01T00:00:00Z"), day))).toEqual([]);
  });

  it("日付は JST に寄せてから出す（UTC のまま出すと1日ずれる）", () => {
    // UTC 22:00 = JST 翌 07:00。毎朝の配信はこの時刻に走る
    expect(formatMonthDay(new Date("2026-09-09T22:00:00Z"))).toBe("9月10日");
    expect(formatMonthDayWeekday(new Date("2026-09-09T22:00:00Z"))).toBe("9月10日・木");
  });
});
