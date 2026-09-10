/**
 * 取り込んだイベントから毎朝のメールの材料を組む（発注 ③-1 / ③-6）。
 *
 * ## いちばん効くのは向きの判定
 *
 * **`metrics.amount` の符号を向きの判定に使わない。**
 * 単一の金額列に「出金」の文字列がある形式では、`api/csv/ingest` が
 * 向きを決めたうえで符号を反転させる。**出金なのに正の値で入ることがある。**
 *
 * 鍵と走査は絶対値で揃えてあるので壊れていないが、
 * **表示側が符号から向きを推し量ると入出金が逆になる。**
 */
import { describe, it, expect } from "vitest";
import {
  RECURRING_MIN_OCCURRENCES,
  breakdownOf,
  ingestedThrough,
  jstDay,
  meetingsOn,
  recurringStates,
  sumCashflow,
  titleCounts,
  toMeeting,
  type SourceEvent,
} from "@edge/_shared/pulse-mail-input";

const OWN = "example.com";

function tx(
  occurredAt: string,
  amount: number,
  direction: string | null,
  description = "取引先A",
): SourceEvent {
  return {
    source: "csv:accounting",
    event_type: "transaction",
    occurred_at: occurredAt,
    metrics: { amount, description, ...(direction === null ? {} : { direction }) },
  };
}

function schedule(title: string, startJst: string, attendees: string[] = []): SourceEvent {
  const start = new Date(`${startJst}+09:00`).toISOString();
  return {
    source: "google_calendar",
    event_type: "schedule",
    occurred_at: start,
    period_start: start,
    period_end: new Date(Date.parse(start) + 3600_000).toISOString(),
    metrics: { title, attendees },
  };
}

const FROM = Date.parse("2026-08-10T00:00:00Z");
const TO = Date.parse("2026-09-10T00:00:00Z");

describe("入出金の向きは direction で決める（発注 ③-6）", () => {
  it("credit は入金、debit は出金。金額は絶対値で扱う", () => {
    const out = sumCashflow(
      [tx("2026-09-01T00:00:00Z", 396000, "credit"), tx("2026-09-02T00:00:00Z", 50000, "debit")],
      FROM,
      TO,
    );
    expect(out.inflowYen).toBe(396000);
    expect(out.outflowYen).toBe(50000);
  });

  it("**陰性**: 出金の行が負値で入っていても、入金として集計しない", () => {
    // 単一の金額列に「出金」の文字列がある形式。取り込み時に符号が反転して
    // **正の値で入る**ことがあり、逆に**負のまま入る**形式もある。
    // どちらも `direction` を見れば正しく数えられる
    const out = sumCashflow([tx("2026-09-02T00:00:00Z", -50000, "debit")], FROM, TO);

    expect(out.outflowYen).toBe(50000);
    expect(out.inflowYen).toBe(0);
  });

  it("**陰性**: 出金の行が正値で入っていても、入金として集計しない", () => {
    const out = sumCashflow([tx("2026-09-02T00:00:00Z", 50000, "debit")], FROM, TO);
    expect(out.outflowYen).toBe(50000);
    expect(out.inflowYen).toBe(0);
  });

  it("**陰性**: 入金の行が負値でも、出金として集計しない", () => {
    const out = sumCashflow([tx("2026-09-01T00:00:00Z", -396000, "credit")], FROM, TO);
    expect(out.inflowYen).toBe(396000);
    expect(out.outflowYen).toBe(0);
  });

  it("**陰性**: 向きが無い行と unknown の行はどちらにも数えない", () => {
    const out = sumCashflow(
      [tx("2026-09-01T00:00:00Z", 1000, null), tx("2026-09-01T00:00:00Z", 2000, "unknown")],
      FROM,
      TO,
    );
    expect(out).toMatchObject({ inflowYen: 0, outflowYen: 0 });
  });

  it("**陰性**: 期間の外は数えない", () => {
    const out = sumCashflow([tx("2026-07-01T00:00:00Z", 999, "credit")], FROM, TO);
    expect(out.inflowYen).toBe(0);
  });

  it("入金の相手先を集める（定期と初めてを分けるのに使う）", () => {
    const out = sumCashflow(
      [
        tx("2026-09-01T00:00:00Z", 100, "credit", "ハクホウドウ"),
        tx("2026-09-02T00:00:00Z", 200, "credit", "アクシス"),
        tx("2026-09-03T00:00:00Z", 300, "debit", "返済"),
      ],
      FROM,
      TO,
    );
    expect([...out.partners].sort()).toEqual(["アクシス", "ハクホウドウ"]);
  });
});

describe("日付は JST で切る", () => {
  it("UTC 15:00 は翌日になる", () => {
    expect(jstDay("2026-09-09T15:00:00Z")).toBe("2026-09-10");
    expect(jstDay("2026-09-09T14:59:00Z")).toBe("2026-09-09");
  });

  it("読めない値は空にする（誤った日に集計しない）", () => {
    expect(jstDay("壊れた値")).toBe("");
  });

  it("取り込めている最後の日を返す", () => {
    expect(
      ingestedThrough([
        tx("2026-08-31T00:00:00Z", 1, "credit"),
        tx("2026-08-01T00:00:00Z", 1, "credit"),
      ]),
    ).toBe("2026-08-31");
  });

  it("**陰性**: 入出金が1件も無ければ null（0件と「まだ無い」を分ける）", () => {
    expect(ingestedThrough([schedule("会議", "2026-09-01T10:00:00")])).toBeNull();
  });
});

describe("出席者は人数と社内外に潰す", () => {
  it("自社ドメインとの一致で分ける", () => {
    const m = toMeeting(
      schedule("会議", "2026-09-08T13:30:00", ["a@example.com", "b@example.org"]),
      OWN,
    );
    expect(m.attendees).toEqual({ total: 2, internal: 1, external: 1 });
  });

  it("**陰性**: 自社ドメインが分からなければ全員を社外に数える", () => {
    const m = toMeeting(schedule("会議", "2026-09-08T13:30:00", ["a@example.com"]), null);
    expect(m.attendees.internal).toBe(0);
  });

  it("**陰性**: 似たドメインを社内と読まない", () => {
    const m = toMeeting(schedule("会議", "2026-09-08T13:30:00", ["a@notexample.example.org"]), OWN);
    expect(m.attendees.internal).toBe(0);
  });
});

describe("繰り返しから定例を見つける", () => {
  const weekly = [0, 7, 14].map((d) =>
    schedule("週次経営会議", `2026-08-${String(24 + d - 14).padStart(2, "0")}T10:00:00`),
  );

  it(`同じ題名が ${RECURRING_MIN_OCCURRENCES} 回以上あるものを定例として扱う`, () => {
    const events = [
      schedule("週次経営会議", "2026-08-24T10:00:00"),
      schedule("週次経営会議", "2026-08-31T10:00:00"),
      schedule("週次経営会議", "2026-09-07T10:00:00"),
      schedule("単発の打ち合わせ", "2026-09-01T14:00:00"),
    ];
    const { rows, titles } = recurringStates(events, new Date("2026-09-09T00:00:00Z"));

    expect(titles.has("週次経営会議")).toBe(true);
    expect(titles.has("単発の打ち合わせ")).toBe(false);
    expect(rows[0]).toMatchObject({ label: "週次経営会議", usual: "7日", state: "通常" });
  });

  it("**陰性**: 2回だけでは定例にしない（たまたま同じ題名を定例にしない）", () => {
    const { titles } = recurringStates(
      [
        schedule("たまたま同じ", "2026-09-01T10:00:00"),
        schedule("たまたま同じ", "2026-09-08T10:00:00"),
      ],
      new Date("2026-09-09T00:00:00Z"),
    );
    expect(titles.size).toBe(0);
  });

  it("通常の間隔の1.5倍を超えたら、空いた日数を書く", () => {
    const events = [
      schedule("週次経営会議", "2026-08-10T10:00:00"),
      schedule("週次経営会議", "2026-08-17T10:00:00"),
      schedule("週次経営会議", "2026-08-24T10:00:00"),
    ];
    const { rows } = recurringStates(events, new Date("2026-09-05T00:00:00Z"));
    expect(rows[0].state).toMatch(/日空いています/);
  });

  it("**陰性**: 1日過ぎただけでは騒がない（毎朝どれかが鳴る形にしない）", () => {
    const events = [
      schedule("週次経営会議", "2026-08-24T10:00:00"),
      schedule("週次経営会議", "2026-08-31T10:00:00"),
      schedule("週次経営会議", "2026-09-07T10:00:00"),
    ];
    const { rows } = recurringStates(events, new Date("2026-09-15T00:00:00Z"));
    expect(rows[0].state).toBe("通常");
  });

  it("題名の出現回数を数えられる", () => {
    expect(titleCounts(weekly).get("週次経営会議")).toBe(3);
  });
});

describe("会議の内訳", () => {
  it("繰り返しを先に見る（題名に「定例」と書いていない定例がある）", () => {
    const meetings = [
      toMeeting(schedule("週次経営会議", "2026-09-08T10:00:00"), OWN),
      toMeeting(schedule("新規パートナー商談", "2026-09-08T14:00:00", ["x@example.org"]), OWN),
      toMeeting(schedule("採用面談（1次）", "2026-09-08T16:00:00"), OWN),
      toMeeting(schedule("DATAZORA 打ち合わせ", "2026-09-08T17:00:00", ["y@example.org"]), OWN),
    ];
    const rows = breakdownOf(meetings, new Set(["週次経営会議"]));
    const get = (label: string) => rows.find((r) => r.label === label)?.count ?? 0;

    expect(get("定例")).toBe(1);
    expect(get("商談")).toBe(1);
    expect(get("採用")).toBe(1);
    expect(get("取引先との打ち合わせ")).toBe(1);
  });

  it("**陰性**: 社外の出席者がいない予定を「取引先との打ち合わせ」にしない", () => {
    const meetings = [toMeeting(schedule("社内の作業", "2026-09-08T10:00:00"), OWN)];
    const rows = breakdownOf(meetings, new Set());
    expect(rows.find((r) => r.label === "取引先との打ち合わせ")?.count).toBe(0);
    expect(rows.find((r) => r.label === "その他")?.count).toBe(1);
  });
});

describe("その日の予定だけを取る", () => {
  it("JST の日付で絞る", () => {
    const events = [
      schedule("昨日", "2026-09-08T10:00:00"),
      schedule("今日", "2026-09-09T10:00:00"),
    ];
    expect(meetingsOn(events, "2026-09-08", OWN).map((m) => m.title)).toEqual(["昨日"]);
    expect(meetingsOn(events, "2026-09-09", OWN).map((m) => m.title)).toEqual(["今日"]);
  });

  it("**陰性**: 取引の行は会議として数えない", () => {
    expect(meetingsOn([tx("2026-09-08T01:00:00Z", 100, "credit")], "2026-09-08", OWN)).toEqual([]);
  });
});
