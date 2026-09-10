/**
 * 毎朝のメールの本文を組む（発注 ③-2）。**判断だけを持つ。**
 *
 * ## 何を直すか
 *
 * これまで出していたのは9項目の観測表で、**読んだ人が自分で解釈する形**だった。
 * 「取り込みの鮮度」「予定の密度」「走査の結果（8本）」は道具の都合であって、
 * 経営者が知りたいことではない。
 *
 * 直す形は**先頭3行で完結する要約**である。昨日の実績・今日の予定・
 * 定期入金と支払いの状態を1行ずつ。**下は必要なときだけ読めばよい。**
 *
 * ## 数字には必ず比較を添える（発注 ③-4）
 *
 * 「会議が5件」だけでは多いのか少ないのか分からない。前週・過去8週の平均・
 * 通常の間隔のどれかを必ず付ける。**比較できないときは「比較できるだけの
 * 履歴がありません」と書く**——黙って数字だけ出さない。
 *
 * ## 残高の金額は出さない（発注 ③-5）
 *
 * メールは転送されうるし、通知に本文の先頭が出る。**残高は最も見られたくない
 * 数字**なので、相対表現（「直近90日で最も低い水準です」）だけにする。
 * 入出金の実額は出す——こちらは相手先ごとの事実であり、状態の説明に要る。
 *
 * ## 入出金の向きは `direction` で決める（発注 ③-6）
 *
 * **`metrics.amount` の符号を向きの判定に使わない。** 単一の金額列に「出金」の
 * 文字列がある形式では、取り込み時に符号が反転して正の値で入る
 * （`api/csv/ingest` の向き判定）。鍵と走査は絶対値で揃っているので壊れていないが、
 * **表示側が符号から向きを推し量ると入出金が逆になる。**
 */

import { formatMonthDay, pulseSubject } from "./mail-words.ts";

/** 直近の入出金を見る窓（日）。試案の「お金の動き（直近30日）」に合わせる */
export const CASHFLOW_WINDOW_DAYS = 30;

/** 会議の内訳。**題名から推し量らず、呼び出し側が決めた区分を受け取る** */
export interface MeetingBreakdown {
  /** 定例・商談・採用・取引先との打ち合わせ・その他 */
  label: string;
  count: number;
}

export interface PulseMeeting {
  startJst: string;
  endJst: string;
  title: string;
  /** 出席者の人数と社内外の別。**アドレスは受け取らない** */
  attendees: { total: number; internal: number; external: number };
}

export interface PulseCashflow {
  /** 取り込めている最後の日（JST の YYYY-MM-DD）。無ければ null */
  ingestedThrough: string | null;
  inflowYen: number;
  outflowYen: number;
  /** 前の同じ長さの窓の入金。比較に使う。無ければ null */
  previousInflowYen: number | null;
  /** 定期の相手先の件数 */
  recurringPartners: number;
  /** 初めての相手先の件数 */
  newPartners: number;
  /** 自社の別口座への振替。**除いていないことを1行添える**（発注 ③-10） */
  transferYen: number | null;
  /** 残高の相対表現。金額は入れない（発注 ③-5） */
  balancePhrase: string | null;
}

/** 定例の会議・定期入金の状態。通常も逸脱も同じ型で出す（発注 ③-4） */
export interface PulseRecurring {
  label: string;
  /** 「7日」「毎月末」 */
  usual: string;
  /** 最後にあった日（JST の YYYY-MM-DD） */
  lastAt: string | null;
  /** 「通常」「9日空いています」「届きました」 */
  state: string;
}

/** 変わった動き。**良い変化も同じ型で出す**（発注 ③-4） */
export interface PulseChange {
  headline: string;
  /** 方向を必ず持たせる */
  direction: "増えた" | "減った" | "止まった" | "届いた";
  /** 根拠。比較対象を含める */
  evidence: string;
  /** 「判断は◯◯さんがされることですが」に続く1文 */
  suggestion: string;
}

export interface PulseCoverage {
  /** 「Google カレンダー: 昨夜 21:00 に取り込み済み（52件）」 */
  connected: string[];
  /** 「会計ソフト・メッセージの往来・勤怠」 */
  notWatching: string[];
}

export interface PulseMailInput {
  /** 報告対象日（昨日）。件名と見出しに使う */
  reportDay: Date;
  /** 宛先の姓。「判断は◯◯さんがされることですが」に入る */
  ownerName: string;
  yesterdayMeetings: PulseMeeting[];
  yesterdayBreakdown: MeetingBreakdown[];
  todayMeetings: PulseMeeting[];
  /** 今日の予定が無いときに添える、前週の同じ曜日の様子 */
  lastWeekSameDay: string | null;
  cashflow: PulseCashflow;
  recurring: PulseRecurring[];
  changes: PulseChange[];
  coverage: PulseCoverage;
  /** 登録からの日数（1日目が初日）。初週の追伸に使う（発注 ③-9） */
  dayIndex: number | null;
  /** 入出金をまだ1件も取り込んでいないか。3日目の追伸を出すかの判断に使う */
  hasCashflowData: boolean;
  /** 取り込みが1件も無い会社か。**空のメールを送らない** */
  hasAnyData: boolean;
}

export interface PulseMail {
  subject: string;
  /** 先頭3行。**ここだけで完結する** */
  summary: string[];
  body: string;
}

/** 初週の追伸（`docs/product/customer-journey-and-copy.md` §5〜6）。**5本だけ** */
export const FIRST_WEEK_NOTES: Record<number, string> = {
  1: "このメールは、毎朝7時に届きます。読まない日があっても構いません。届かない日はこちらで気づいて対応します。",
  2: "「定例の状態」は、同じ題名の予定が3回以上続いたものを定例として扱っています。違うものが混ざっていたら、ダッシュボードの「これは通常です」で外せます。",
  3: "銀行の入出金明細（CSV）を取り込むと、月末の定期入金の到着と残高の動きが加わります。取り込みは1分です。",
  5: "メールの一番上の3行だけ読めば、その日の状態は分かるようにしています。下は必要なときだけ。",
  7: "明日、初めての「今週の会社」が届きます。1週間分をまとめたものです。",
};

/**
 * その日に出す追伸を決める（発注 ③-9）。**8日目以降は出さない。**
 *
 * 3日目は**入出金をまだ取り込んでいない会社だけ**。取り込んだ会社に
 * 「取り込むと見えます」と言い続けるのは、読んでいないのと同じである。
 *
 * 4日目と6日目は**そもそも無い**。毎日1本ずつ出すと、
 * 追伸のほうが本文より目立つ。
 */
export function firstWeekNote(dayIndex: number | null, hasCashflowData: boolean): string | null {
  if (dayIndex === null || dayIndex < 1 || dayIndex > 7) return null;
  if (dayIndex === 3 && hasCashflowData) return null;
  return FIRST_WEEK_NOTES[dayIndex] ?? null;
}

/** 「3,145,068円」 */
export function yen(amount: number): string {
  return `${Math.round(amount).toLocaleString("ja-JP")}円`;
}

/** 「2026-09-08」→「9月8日」。**年は出さない**（毎朝届くので要らない） */
function jaDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  return `${Number(m[2])}月${Number(m[3])}日`;
}

/** 「2026-09-08」→「9/8」。表の中で使う */
function shortDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  return `${Number(m[2])}/${Number(m[3])}`;
}

/** 「定例3件・商談1件・採用1件」。0件の区分は出さない */
function breakdownText(rows: MeetingBreakdown[]): string {
  return rows
    .filter((r) => r.count > 0)
    .map((r) => `${r.label}${r.count}件`)
    .join("・");
}

/** 会議の合計時間（分） */
export function totalMinutes(meetings: PulseMeeting[]): number {
  let sum = 0;
  for (const m of meetings) {
    const start = Date.parse(m.startJst);
    const end = Date.parse(m.endJst);
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;
    sum += Math.round((end - start) / 60000);
  }
  return sum;
}

/** 「13:30–14:15」 */
function timeRange(m: PulseMeeting): string {
  const at = (iso: string) => {
    const jst = new Date(Date.parse(iso) + 9 * 60 * 60 * 1000);
    const hh = String(jst.getUTCHours()).padStart(2, "0");
    const mm = String(jst.getUTCMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  };
  return `${at(m.startJst)}–${at(m.endJst)}`;
}

/** 「（社外2名）」「（社内3名・社外1名）」。**アドレスは出さない** */
function attendeeText(a: PulseMeeting["attendees"]): string {
  const parts: string[] = [];
  if (a.internal > 0) parts.push(`社内${a.internal}名`);
  if (a.external > 0) parts.push(`社外${a.external}名`);
  return parts.length > 0 ? `（${parts.join("・")}）` : "";
}

/** 先頭3行。**ここだけで完結する**（発注 ③-2） */
export function buildSummary(input: PulseMailInput): string[] {
  const { yesterdayMeetings, yesterdayBreakdown, cashflow, recurring, reportDay } = input;
  const day = formatMonthDay(reportDay);

  const minutes = totalMinutes(yesterdayMeetings);
  const breakdown = breakdownText(yesterdayBreakdown);
  const line1 =
    yesterdayMeetings.length === 0
      ? `${day}は会議がありませんでした。`
      : `${day}は会議が${yesterdayMeetings.length}件、${minutes}分でした` +
        `${breakdown ? `（${breakdown}）` : ""}。`;

  const line2 = cashflow.ingestedThrough
    ? `入出金は${jaDate(cashflow.ingestedThrough)}分まで取り込み済みです。`
    : "入出金はまだ取り込んでいません。";

  const waiting = recurring.filter((r) => r.state !== "通常" && r.state !== "届きました");
  const line3 =
    recurring.length === 0
      ? "繰り返しの予定と入金は、まだ見つかっていません。"
      : waiting.length === 0
        ? "定例の会議と定期入金は、すべて通常どおりです。"
        : `${waiting.map((r) => `「${r.label}」`).join("と")}が通常と違います。ほかは通常です。`;

  return [line1, line2, line3];
}

/**
 * 本文を組む。
 *
 * **取り込みが1件も無ければ、空のメールを送らない。** 見出しだけが並ぶ
 * メールは「壊れている」と読まれる。何が要るかを1つだけ書く。
 */
export function buildPulseMail(input: PulseMailInput): PulseMail {
  const subject = pulseSubject(input.reportDay);
  const note = firstWeekNote(input.dayIndex, input.hasCashflowData);

  if (!input.hasAnyData) {
    const summary = ["まだ取り込みがありません。"];
    return {
      subject,
      summary,
      body: [
        ...summary,
        "",
        "Google カレンダーをつなぐと、翌朝から会議の量と内訳が届きます。",
        "入出金明細（CSV）を取り込むと、定期入金の到着と残高の動きが加わります。",
        ...(note ? ["", `追伸: ${note}`] : []),
      ].join("\n"),
    };
  }

  const summary = buildSummary(input);
  const lines: string[] = [...summary, ""];

  if (input.changes.length > 0) {
    lines.push(`変わった動きが${input.changes.length}件`, "");
    for (const c of input.changes) {
      lines.push(
        `${c.headline}（${c.direction}）`,
        c.evidence,
        `判断は${input.ownerName}さんがされることですが、${c.suggestion}`,
        "［対応した］［見送る］［これは通常です］［根拠を見る］",
        "",
      );
    }
  }

  lines.push("■ 昨日の実績");
  if (input.yesterdayMeetings.length === 0) {
    lines.push("会議はありませんでした。");
  } else {
    for (const m of input.yesterdayMeetings) {
      lines.push(`${timeRange(m)} ${m.title}${attendeeText(m.attendees)}`);
    }
  }
  lines.push("");

  lines.push("■ 今日の予定");
  if (input.todayMeetings.length === 0) {
    lines.push(
      input.lastWeekSameDay
        ? `予定は入っていません。${input.lastWeekSameDay}`
        : "予定は入っていません。",
    );
  } else {
    for (const m of input.todayMeetings) {
      lines.push(`${timeRange(m)} ${m.title}${attendeeText(m.attendees)}`);
    }
  }
  lines.push("");

  lines.push(`■ お金の動き（直近${CASHFLOW_WINDOW_DAYS}日）`);
  const c = input.cashflow;
  if (!c.ingestedThrough) {
    lines.push("入出金をまだ取り込んでいません。");
  } else {
    const compare =
      c.previousInflowYen === null
        ? "比較できるだけの履歴がありません"
        : c.inflowYen >= c.previousInflowYen
          ? `前の${CASHFLOW_WINDOW_DAYS}日（${yen(c.previousInflowYen)}）より多い期間でした`
          : `前の${CASHFLOW_WINDOW_DAYS}日（${yen(c.previousInflowYen)}）より少ない期間でした`;
    lines.push(
      `入金は ${yen(c.inflowYen)} で、${compare}。` +
        `定期の相手先 ${c.recurringPartners}件、初めての相手先 ${c.newPartners}件からです。`,
      `支払いは ${yen(c.outflowYen)}。`,
    );
    if (c.transferYen !== null) {
      // **除いていないことを書く**（発注 ③-10）。除く処理は後続の発注 B で入れる
      lines.push(`自社の別口座への振替 ${yen(c.transferYen)} を含みます。`);
    }
    if (c.balancePhrase) lines.push(c.balancePhrase);
  }
  lines.push("");

  lines.push("■ 定例の状態");
  if (input.recurring.length === 0) {
    lines.push("繰り返しの予定と入金は、まだ見つかっていません。");
  } else {
    for (const r of input.recurring) {
      const last = r.lastAt ? `最終 ${shortDate(r.lastAt)}` : "最終 なし";
      lines.push(`${r.label}　通常 ${r.usual}　${last}　${r.state}`);
    }
  }
  lines.push("");

  lines.push("■ 見えているもの");
  for (const line of input.coverage.connected) lines.push(line);
  if (input.coverage.notWatching.length > 0) {
    lines.push(`まだ見ていないもの: ${input.coverage.notWatching.join("・")}。`);
  }

  if (note) lines.push("", `追伸: ${note}`);

  return { subject, summary, body: lines.join("\n") };
}
