/**
 * 取り込んだイベントから、毎朝のメールの材料を組む（発注 ③-1）。**判断だけを持つ。**
 *
 * ## 入出金の向きは `direction` だけで決める（発注 ③-6）
 *
 * **`metrics.amount` の符号を向きの判定に使わない。**
 * 単一の金額列に「出金」の文字列がある形式では、`api/csv/ingest` が
 * 向きを決めたうえで符号を反転させる。**出金なのに正の値で入ることがある。**
 *
 * 鍵（`csvEventId`）と走査（`runScan`）は絶対値で揃えてあるので壊れていないが、
 * **表示側が符号から向きを推し量ると入出金が逆になる。**
 * ここでは `direction` を見て、金額は絶対値で扱う。
 *
 * ## 会議の区分は題名だけで決めない
 *
 * 「定例」は**繰り返しているかどうか**で決める。題名に「定例」と書いていない
 * 定例会議はいくらでもあるし、「定例報告書の作成」は定例会議ではない。
 * 繰り返しの検出（同じ題名が3回以上）を先に置き、そこから漏れたものだけを
 * 題名の語と出席者の顔ぶれで分ける。
 */

import type { MeetingBreakdown, PulseMeeting, PulseRecurring } from "./pulse-mail.ts";

/** メールの材料に使うイベント（`PacketEvent` の必要な部分だけ） */
export interface SourceEvent {
  source: string;
  event_type: string;
  occurred_at: string;
  metrics: unknown;
  /** 予定の開始・終了。`events` の列と同じ名前 */
  period_start?: string | null;
  period_end?: string | null;
}

/** 同じ題名が何回続けば「定例」とみなすか（`customer-journey-and-copy.md` §5〜6 の2日目） */
export const RECURRING_MIN_OCCURRENCES = 3;

const DAY_MS = 86_400_000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** JST の日付（YYYY-MM-DD）。**UTC のまま切ると1日ずれる** */
export function jstDay(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const jst = new Date(at + JST_OFFSET_MS);
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  return `${jst.getUTCFullYear()}-${m}-${d}`;
}

function metricsOf(e: SourceEvent): Record<string, unknown> {
  return typeof e.metrics === "object" && e.metrics !== null
    ? (e.metrics as Record<string, unknown>)
    : {};
}

function titleOf(e: SourceEvent): string {
  const t = metricsOf(e).title;
  return typeof t === "string" && t.trim() ? t.trim() : "(無題)";
}

/**
 * 予定を1件の会議にする。**出席者はここで人数に潰す。**
 *
 * `ownDomain` が無ければ全員を社外に数える。**分からないものを社内にしない。**
 */
export function toMeeting(e: SourceEvent, ownDomain: string | null): PulseMeeting {
  const m = metricsOf(e);
  const raw = Array.isArray(m.attendees) ? m.attendees : [];
  const domain = (ownDomain ?? "").trim().toLowerCase().replace(/^@/, "");

  let internal = 0;
  let total = 0;
  for (const a of raw) {
    const address = typeof a === "string" ? a : "";
    if (!address) continue;
    total++;
    const at = address.lastIndexOf("@");
    if (domain && at >= 0 && address.slice(at + 1).toLowerCase() === domain) internal++;
  }

  return {
    startJst: e.period_start ?? e.occurred_at,
    endJst: e.period_end ?? e.period_start ?? e.occurred_at,
    title: titleOf(e),
    attendees: { total, internal, external: total - internal },
  };
}

/** その日（JST）の予定だけを取る */
export function meetingsOn(events: SourceEvent[], day: string, ownDomain: string | null) {
  return events
    .filter((e) => e.event_type === "schedule")
    .filter((e) => jstDay(e.period_start ?? e.occurred_at) === day)
    .map((e) => toMeeting(e, ownDomain));
}

/** 題名ごとの出現回数。**繰り返しの検出に使う** */
export function titleCounts(events: SourceEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.event_type !== "schedule") continue;
    const t = titleOf(e);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return counts;
}

/**
 * 会議の内訳（発注 ③-2）。
 *
 * **繰り返しを先に見る。** 題名に「定例」と書いていない定例会議は多い。
 * 残りを題名の語で分け、どれにも当たらず社外の出席者がいるものを
 * 「取引先との打ち合わせ」にする。
 */
export function breakdownOf(
  meetings: PulseMeeting[],
  recurringTitles: Set<string>,
): MeetingBreakdown[] {
  const counts = { 定例: 0, 商談: 0, 採用: 0, 取引先との打ち合わせ: 0, その他: 0 };

  for (const m of meetings) {
    if (recurringTitles.has(m.title)) counts["定例"]++;
    else if (/商談|打合せ|打ち合わせ/.test(m.title) && /商談/.test(m.title)) counts["商談"]++;
    else if (/採用|面接|面談/.test(m.title)) counts["採用"]++;
    else if (m.attendees.external > 0) counts["取引先との打ち合わせ"]++;
    else counts["その他"]++;
  }

  return Object.entries(counts).map(([label, count]) => ({ label, count }));
}

export interface CashflowTotals {
  inflowYen: number;
  outflowYen: number;
  /** 相手先（摘要）の集合。定期かどうかの判定に使う */
  partners: Set<string>;
}

/**
 * 期間内の入出金を集める（発注 ③-6）。
 *
 * **向きは `direction` だけで決め、金額は絶対値で扱う。**
 * `direction` が無い行は**どちらにも入れない**——符号から推し量ると、
 * 取り込み時に反転した行が逆に数えられる。
 */
export function sumCashflow(events: SourceEvent[], fromMs: number, toMs: number): CashflowTotals {
  const out: CashflowTotals = { inflowYen: 0, outflowYen: 0, partners: new Set() };

  for (const e of events) {
    if (e.event_type !== "transaction") continue;
    const at = Date.parse(e.occurred_at);
    if (Number.isNaN(at) || at < fromMs || at >= toMs) continue;

    const m = metricsOf(e);
    const amount = m.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount)) continue;

    const direction = typeof m.direction === "string" ? m.direction : "";
    const value = Math.abs(amount);

    if (direction === "credit") {
      out.inflowYen += value;
      const desc = typeof m.description === "string" ? m.description : "";
      if (desc) out.partners.add(desc);
    } else if (direction === "debit") {
      out.outflowYen += value;
    }
    // **`unknown` と、向きの無い行は数えない。** 片側に足すと総額が狂う
  }

  return out;
}

/** 取り込めている最後の日（JST）。1件も無ければ null */
export function ingestedThrough(events: SourceEvent[]): string | null {
  let latest: string | null = null;
  for (const e of events) {
    if (e.event_type !== "transaction") continue;
    const day = jstDay(e.occurred_at);
    if (!day) continue;
    if (latest === null || day > latest) latest = day;
  }
  return latest;
}

/**
 * 定例の状態（発注 ③-2）。**通常も逸脱も同じ型で出す。**
 *
 * 同じ題名が `RECURRING_MIN_OCCURRENCES` 回以上あるものを定例として扱い、
 * 間隔の中央値を「通常」とする。最後から中央値の1.5倍を超えて空いていれば、
 * 空いた日数を書く。
 */
export function recurringStates(
  events: SourceEvent[],
  now: Date,
): { rows: PulseRecurring[]; titles: Set<string> } {
  const byTitle = new Map<string, number[]>();
  for (const e of events) {
    if (e.event_type !== "schedule") continue;
    const at = Date.parse(e.period_start ?? e.occurred_at);
    if (Number.isNaN(at)) continue;
    const t = titleOf(e);
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t)!.push(at);
  }

  const rows: PulseRecurring[] = [];
  const titles = new Set<string>();

  for (const [title, times] of byTitle) {
    if (times.length < RECURRING_MIN_OCCURRENCES) continue;
    times.sort((a, b) => a - b);

    const gaps: number[] = [];
    for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / DAY_MS);
    if (gaps.length === 0) continue;

    gaps.sort((a, b) => a - b);
    const usualDays = Math.round(gaps[Math.floor(gaps.length / 2)]);
    if (usualDays <= 0) continue;

    titles.add(title);
    const last = times[times.length - 1];
    const sinceDays = Math.floor((now.getTime() - last) / DAY_MS);

    rows.push({
      label: title,
      usual: `${usualDays}日`,
      lastAt: jstDay(new Date(last).toISOString()),
      // **1.5倍を超えたら書く。** 1日でも過ぎたら騒ぐと、毎朝どれかが鳴る
      state: sinceDays > usualDays * 1.5 ? `${sinceDays}日空いています` : "通常",
    });
  }

  rows.sort((a, b) => a.label.localeCompare(b.label, "ja"));
  return { rows, titles };
}
