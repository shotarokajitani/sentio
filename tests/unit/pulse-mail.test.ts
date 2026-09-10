/**
 * 毎朝のメールの本文（発注 ③-2 / ③-4 / ③-5 / ③-9）。
 *
 * ## 何を直したか
 *
 * これまで出していたのは9項目の観測表で、**読んだ人が自分で解釈する形**だった。
 * 「取り込みの鮮度」「予定の密度」は道具の都合であって、経営者が知りたいことではない。
 *
 * 直した形は**先頭3行で完結する要約**である。下は必要なときだけ読めばよい。
 */
import { describe, it, expect } from "vitest";
import {
  CASHFLOW_WINDOW_DAYS,
  FIRST_WEEK_NOTES,
  buildPulseMail,
  buildSummary,
  firstWeekNote,
  totalMinutes,
  type PulseMailInput,
} from "@edge/_shared/pulse-mail";
import { findForbiddenWords } from "@edge/_shared/mail-words";

const REPORT_DAY = new Date("2026-09-08T00:00:00Z");

function baseInput(over: Partial<PulseMailInput> = {}): PulseMailInput {
  return {
    reportDay: REPORT_DAY,
    ownerName: "梶谷",
    yesterdayMeetings: [
      {
        startJst: "2026-09-08T04:30:00Z",
        endJst: "2026-09-08T05:15:00Z",
        title: "打ち合わせ",
        attendees: { total: 2, internal: 0, external: 2 },
      },
    ],
    yesterdayBreakdown: [
      { label: "定例", count: 0 },
      { label: "取引先との打ち合わせ", count: 1 },
    ],
    todayMeetings: [],
    lastWeekSameDay: "先週の火曜は商談が1件（90分）ありました。",
    cashflow: {
      ingestedThrough: "2026-08-31",
      inflowYen: 3145068,
      outflowYen: 55250,
      previousInflowYen: 1766469,
      recurringPartners: 2,
      newPartners: 2,
      transferYen: 3460000,
      balancePhrase: "残高は、直近90日で最も低い水準です。",
    },
    recurring: [
      { label: "週次経営会議", usual: "7日", lastAt: "2026-08-31", state: "9日空いています" },
      { label: "開発デイリー", usual: "7日", lastAt: "2026-09-02", state: "通常" },
    ],
    changes: [
      {
        headline: "「週次経営会議」が今週はまだ入っていません",
        direction: "止まった",
        evidence: "8月24日・8月31日と7日おきに続いていました（通常の間隔 7日、前回から9日）。",
        suggestion: "開催しない週であれば「見送る」で、次から通常として扱います。",
      },
    ],
    coverage: {
      connected: ["Google カレンダー: 昨夜 21:00 に取り込み済み（52件）。"],
      notWatching: ["会計ソフト", "メッセージの往来", "勤怠"],
    },
    dayIndex: null,
    hasCashflowData: true,
    hasAnyData: true,
    ...over,
  };
}

describe("先頭3行で完結する", () => {
  it("会議の量と内訳、入出金、定例の状態が1行ずつ", () => {
    const summary = buildSummary(baseInput());

    expect(summary).toHaveLength(3);
    expect(summary[0]).toBe("9月8日は会議が1件、45分でした（取引先との打ち合わせ1件）。");
    expect(summary[1]).toBe("入出金は8月31日分まで取り込み済みです。");
    expect(summary[2]).toContain("「週次経営会議」が通常と違います");
  });

  it("すべて通常なら3行目でそう言い切る", () => {
    const summary = buildSummary(
      baseInput({
        recurring: [{ label: "開発デイリー", usual: "7日", lastAt: "2026-09-02", state: "通常" }],
      }),
    );
    expect(summary[2]).toBe("定例の会議と定期入金は、すべて通常どおりです。");
  });

  it("0件の区分は内訳に出さない", () => {
    const summary = buildSummary(baseInput());
    expect(summary[0]).not.toContain("定例0件");
  });
});

describe("残高の金額を本文に出さない（発注 ③-5）", () => {
  it("相対表現だけを出す", () => {
    const mail = buildPulseMail(baseInput());
    expect(mail.body).toContain("残高は、直近90日で最も低い水準です。");
  });

  it("**陰性**: 残高の金額を渡しても、そのまま出る経路が無い", () => {
    // 呼び出し側が金額入りの文を渡せば出てしまう。**渡す側で止める**のが約束で、
    // ここで固定するのは「本文に残高の金額を組み立てる処理が無い」ことである
    const mail = buildPulseMail(baseInput());
    const source = mail.body;
    // 入出金の実額は出る（相手先ごとの事実であり、状態の説明に要る）
    expect(source).toContain("3,145,068円");
    // 残高の金額は組み立てていない
    expect(source).not.toMatch(/残高は[^\n]*円/);
  });

  it("入出金には必ず比較を添える（発注 ③-4）", () => {
    const mail = buildPulseMail(baseInput());
    expect(mail.body).toContain(`前の${CASHFLOW_WINDOW_DAYS}日（1,766,469円）より多い期間でした`);
  });

  it("**陰性**: 比べる相手がいないときは比を出さず、そう書く", () => {
    const mail = buildPulseMail(
      baseInput({ cashflow: { ...baseInput().cashflow, previousInflowYen: null } }),
    );
    expect(mail.body).toContain("比較できるだけの履歴がありません");
    expect(mail.body).not.toContain("より多い期間");
  });

  it("自社の別口座への振替を含むことを1行添える（発注 ③-10）", () => {
    expect(buildPulseMail(baseInput()).body).toContain(
      "自社の別口座への振替 3,460,000円 を含みます。",
    );
  });
});

describe("初週の追伸（発注 ③-9）", () => {
  it("出るのは1・2・3・5・7日目の5本だけ", () => {
    expect(
      Object.keys(FIRST_WEEK_NOTES)
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual([1, 2, 3, 5, 7]);
  });

  it("**陰性**: 8日目の会社に追伸が出ない", () => {
    expect(firstWeekNote(8, false)).toBeNull();
    expect(buildPulseMail(baseInput({ dayIndex: 8 })).body).not.toContain("追伸");
  });

  it("**陰性**: 4日目と6日目は出さない（毎日出すと追伸のほうが目立つ）", () => {
    expect(firstWeekNote(4, false)).toBeNull();
    expect(firstWeekNote(6, false)).toBeNull();
  });

  it("**陰性**: 3日目は、入出金を取り込んだ会社には出さない", () => {
    expect(firstWeekNote(3, true)).toBeNull();
    expect(firstWeekNote(3, false)).toContain("銀行の入出金明細");
  });

  it("7日目の追伸が、初回の週次の1行と対になっている", () => {
    expect(firstWeekNote(7, true)).toContain("明日、初めての「今週の会社」が届きます");
  });

  it("2日目の追伸のボタンの語が「これは通常です」になっている", () => {
    expect(firstWeekNote(2, true)).toContain("これは通常です");
    expect(firstWeekNote(2, true)).not.toContain("これは平常です");
  });
});

describe("取り込みが0件の会社（発注 ③-11 の d）", () => {
  it("**陰性**: 空のメールを送らず、定型を1つ出す", () => {
    const mail = buildPulseMail(baseInput({ hasAnyData: false }));

    expect(mail.summary).toEqual(["まだ取り込みがありません。"]);
    expect(mail.body).toContain("Google カレンダーをつなぐと");
    // 見出しだけが並ぶメールにしない
    expect(mail.body).not.toContain("■ 昨日の実績");
    expect(mail.body).not.toContain("■ お金の動き");
  });

  it("取り込みが0件でも初週の追伸は出す", () => {
    const mail = buildPulseMail(baseInput({ hasAnyData: false, dayIndex: 1 }));
    expect(mail.body).toContain("追伸: このメールは、毎朝7時に届きます。");
  });
});

describe("本文の作法", () => {
  it("件名が確定した形になっている", () => {
    expect(buildPulseMail(baseInput()).subject).toBe("【Sentio】今日の会社（9月8日・火）");
  });

  it("**陰性**: 本文に内部の語が1つも出ない", () => {
    const mail = buildPulseMail(baseInput());
    const hits = findForbiddenWords(`${mail.subject}\n${mail.body}`);
    expect(hits, `禁止語が混ざっている: ${hits.join(", ")}`).toEqual([]);
  });

  it("**陰性**: 出席者のアドレスを受け取る口が無い（人数と社内外だけ）", () => {
    const mail = buildPulseMail(baseInput());
    expect(mail.body).toContain("（社外2名）");
    expect(mail.body).not.toContain("@");
  });

  it("変わった動きに方向と4つの導線が付く（発注 ③-4）", () => {
    const body = buildPulseMail(baseInput()).body;
    expect(body).toContain("（止まった）");
    expect(body).toContain("判断は梶谷さんがされることですが、");
    expect(body).toContain("［対応した］［見送る］［これは通常です］［根拠を見る］");
  });

  it("会議の合計時間は開始と終了から数える", () => {
    expect(totalMinutes(baseInput().yesterdayMeetings)).toBe(45);
  });

  it("**陰性**: 終了が開始より前の行は数えない（0分や負にしない）", () => {
    const broken = [
      {
        startJst: "2026-09-08T05:00:00Z",
        endJst: "2026-09-08T04:00:00Z",
        title: "壊れた予定",
        attendees: { total: 0, internal: 0, external: 0 },
      },
    ];
    expect(totalMinutes(broken)).toBe(0);
  });
});
