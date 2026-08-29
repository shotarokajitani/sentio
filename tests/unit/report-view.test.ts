import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReportView } from "@/app/report/report-view";
import { summarizeWeek, type EventRow, type WeeklySummary } from "@shared/report/weekly";
import { ja } from "@/i18n/ja";

/**
 * 契約 W-2-1 / W-3-1 / W-3-2 と、W-1-5 の**表示側**の担保。
 *
 * 集計が正しくても、画面が生の値を描けば同じことである。
 * ここはレンダ結果の文字列を直接見る。
 *
 * **フィクスチャのメールアドレスは実在しない値に固定する**（契約 停止点）。
 */
const FAKE_ATTENDEE = "nobody@example.invalid";
const FAKE_ATTENDEE_2 = "someone-else@example.invalid";

const REFERENCE = new Date("2026-08-28T00:00:00Z");

function row(overrides: Partial<EventRow> = {}): EventRow {
  return {
    source: "google_calendar",
    event_type: "schedule",
    period_start: "2026-08-25T01:00:00Z",
    period_end: "2026-08-25T02:00:00Z",
    metrics: { title: "定例", attendees: [FAKE_ATTENDEE] },
    ...overrides,
  };
}

function render(summary: WeeklySummary | null): string {
  return renderToStaticMarkup(createElement(ReportView, { summary }));
}

describe("ReportView — W-2-1 陰性コントロール: 出席者のメールアドレスをHTMLに出さない", () => {
  it("HTMLに出席者のメールアドレスが1文字も出ない", () => {
    const html = render(
      summarizeWeek(
        [
          row({ metrics: { title: "定例", attendees: [FAKE_ATTENDEE, FAKE_ATTENDEE_2] } }),
          row({
            period_start: "2026-08-26T01:00:00Z",
            period_end: "2026-08-26T02:00:00Z",
            metrics: { title: "商談", attendees: [FAKE_ATTENDEE] },
          }),
        ],
        REFERENCE,
      ),
    );

    expect(html).not.toContain(FAKE_ATTENDEE);
    expect(html).not.toContain(FAKE_ATTENDEE_2);
    expect(html).not.toContain("example.invalid");
    expect(html).not.toContain("nobody");
    expect(html).not.toContain("@");
  });

  it("人数は出る（メールアドレスの代わりに数だけを見せる）", () => {
    const html = render(
      summarizeWeek(
        [row({ metrics: { title: "定例", attendees: [FAKE_ATTENDEE, FAKE_ATTENDEE_2] } })],
        REFERENCE,
      ),
    );
    expect(html).toContain(ja.report.attendeesLabel);
    expect(html).toContain("2");
  });
});

describe("ReportView — W-3-1 / W-3-2: 0件と失敗を別物として描く", () => {
  it("予定が0件の週は「予定がありません」を出す", () => {
    const html = render(summarizeWeek([], REFERENCE));
    expect(html).toContain(ja.report.emptyTitle);
  });

  it("0件のとき、失敗の文言は出ない", () => {
    const html = render(summarizeWeek([], REFERENCE));
    expect(html).not.toContain(ja.report.loadFailedTitle);
  });

  it("取得に失敗（null）のときは「読み込めませんでした」を出す", () => {
    const html = render(null);
    expect(html).toContain(ja.report.loadFailedTitle);
  });

  it("失敗のとき、0件の文言は出ない", () => {
    const html = render(null);
    expect(html).not.toContain(ja.report.emptyTitle);
  });

  it("失敗は role=alert で描く（0件は alert にしない）", () => {
    expect(render(null)).toContain('role="alert"');
    expect(render(summarizeWeek([], REFERENCE))).not.toContain('role="alert"');
  });
});

describe("ReportView — W-1-5 の表示: 前週が無いときに 0% と書かない", () => {
  it("前週0件なら「比較できるだけの履歴がありません」を出す", () => {
    const html = render(summarizeWeek([row()], REFERENCE));
    expect(html).toContain(ja.report.noComparison);
  });

  it("前週0件のとき「0%」がHTMLに現れない", () => {
    const html = render(summarizeWeek([row()], REFERENCE));
    expect(html).not.toContain("0%");
  });

  it("前週に実績があるときは増減率を出す（増加は符号つき）", () => {
    const html = render(
      summarizeWeek(
        [
          row({ period_start: "2026-08-18T01:00:00Z", period_end: "2026-08-18T02:00:00Z" }),
          row({ period_start: "2026-08-24T01:00:00Z", period_end: "2026-08-24T02:00:00Z" }),
          row({ period_start: "2026-08-25T01:00:00Z", period_end: "2026-08-25T02:00:00Z" }),
        ],
        REFERENCE,
      ),
    );
    expect(html).toContain("+100%");
    expect(html).not.toContain(ja.report.noComparison);
  });
});

describe("ReportView — W-D5: 件名と時刻の見せ方", () => {
  it("予定の件名が出る", () => {
    const html = render(summarizeWeek([row({ metrics: { title: "四半期レビュー" } })], REFERENCE));
    expect(html).toContain("四半期レビュー");
  });

  it("件名が無い予定は言い換えて出す（空欄にしない）", () => {
    const html = render(summarizeWeek([row({ metrics: {} })], REFERENCE));
    expect(html).toContain(ja.report.untitled);
  });

  it("時刻は JST で描く（サーバのUTCで描かない）", () => {
    // 2026-08-25T01:00:00Z = 2026-08-25 10:00 JST
    const html = render(summarizeWeek([row()], REFERENCE));
    expect(html).toContain("10:00");
    expect(html).not.toContain("01:00");
  });

  it("週の範囲も JST で描く（JST 月曜 8/24 〜 日曜 8/30）", () => {
    const html = render(summarizeWeek([], REFERENCE));
    expect(html).toContain("8月24日");
    expect(html).toContain("8月30日");
  });

  it("終日予定は時刻ではなく「終日」と描く", () => {
    const html = render(
      summarizeWeek(
        [
          row({
            period_start: "2026-08-25T00:00:00Z",
            period_end: "2026-08-26T00:00:00Z",
            metrics: { title: "終日: 出張" },
          }),
        ],
        REFERENCE,
      ),
    );
    expect(html).toContain(ja.report.allDayLabel);
  });

  it("総会議時間は時間と分で描く", () => {
    const html = render(
      summarizeWeek(
        [row({ period_start: "2026-08-25T01:00:00Z", period_end: "2026-08-25T02:30:00Z" })],
        REFERENCE,
      ),
    );
    expect(html).toContain(ja.report.duration(90));
  });
});

describe("ReportView — 画面の骨格", () => {
  it("見出しと説明が辞書経由で出る", () => {
    const html = render(summarizeWeek([row()], REFERENCE));
    expect(html).toContain(ja.report.title);
    expect(html).toContain(ja.report.lead);
  });

  it("接続の設定へ戻る導線がある", () => {
    expect(render(summarizeWeek([row()], REFERENCE))).toContain('href="/connect"');
  });
});

describe("導線 — /connect から /report へ1本だけ（契約 実装順3）", () => {
  it("/connect に /report へのリンクがある", async () => {
    const { ConnectClient } = await import("@/app/connect/connect-client");
    const html = renderToStaticMarkup(
      createElement(ConnectClient, {
        failureMessage: null,
        initialOverview: { connections: [], counts: {} },
        accountEmail: null,
      }),
    );
    expect(html).toContain('href="/report"');
    expect(html).toContain(ja.connect.weeklyReport);
  });

  it("導線は1本だけ（同じリンクを何本も置かない）", async () => {
    const { ConnectClient } = await import("@/app/connect/connect-client");
    const html = renderToStaticMarkup(
      createElement(ConnectClient, {
        failureMessage: null,
        initialOverview: { connections: [], counts: {} },
        accountEmail: null,
      }),
    );
    expect(html.split('href="/report"').length - 1).toBe(1);
  });
});
