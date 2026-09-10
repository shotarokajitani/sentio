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

/** 取引先ごとの接点と入金（発注 ③-3 の「取引先の動き」） */
export interface PartnerRow {
  name: string;
  /** 「9月7日 打ち合わせ（初回）」「会議なし（最終 5月29日）」 */
  contact: string;
  /** 「8月31日 396,000円（定期）」。無ければ null */
  deposit: string | null;
}

/** 主要指標の1行。**今週だけを出さず、必ず比較を添える**（発注 ③-4） */
export interface MetricRow {
  label: string;
  thisWeek: string;
  lastWeek: string;
  /** 過去8週の平均。**`baselines` の帯とは別物**（あちらは全期間） */
  average8w: string;
}

/** 定例会議・定期入金の状態。通常も逸脱も同じ型で出す */
export interface RecurringRow {
  label: string;
  usual: string;
  lastAt: string | null;
  state: string;
}

export interface WeeklySectionsInput {
  /** 画面と同じ `summarizeWeek` の出力。メール側で数え直さない */
  summary: WeeklySummary;
  findings: FindingRow[];
  activeProviders: string[];
  csvCount: number;
  calCount: number;
  /**
   * ここから下は発注 ③ で足した節の材料。**すべて任意**にしてある——
   * 集めるのは呼び出し側の仕事で、集められない環境では節を落とす。
   * **空の見出しだけを出さない。**
   */
  /** 「先週の要約」の2行目。入出金の1行 */
  cashflowLine?: string;
  /** 「先週の要約」の3行目。定例の1行 */
  recurringLine?: string;
  /** 前週からの変化に出す本文（Finding の `rendered`） */
  renderedFindings?: string[];
  partners?: PartnerRow[];
  metrics?: MetricRow[];
  recurring?: RecurringRow[];
  /** 「見通し」。実績が足りないときは呼び出し側が null にする */
  outlook?: string | null;
  /** 「来週の予定」 */
  nextWeek?: string | null;
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

/**
 * 表の1行。**全角の空白で区切る。**
 *
 * メールは等幅で読まれるとは限らないので、桁を揃える書き方は当てにできない。
 * 全角の空白なら、どの書体でも列の切れ目が見える。
 */
function row(cells: string[]): string {
  return cells.join("　");
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

/**
 * 「前週からの変化」（内部の型は `finding`）。
 *
 * **`rendered` があればそれを出す。** `- what` の1行は「見えたこと」しか伝えず、
 * 根拠も選択肢も落ちる（発注 ③-3）。
 *
 * **0件の週も節を消さない。** 見出しごと消えると「何も見ていない」のか
 * 「見たが何も無かった」のかが区別できない。
 */
function findingContent(input: WeeklySectionsInput): string {
  const rendered = (input.renderedFindings ?? []).filter((r) => r.trim().length > 0);
  if (rendered.length > 0) return rendered.slice(0, 2).join("\n\n");

  const top = input.findings.slice(0, 2);
  if (top.length > 0) return top.map((f) => `- ${f.what}`).join("\n");
  return "前週から変わった動きはありませんでした。";
}

/**
 * 「取引先の動き」（内部の型は `followup`）。
 *
 * 前週までに出した項目のその後を**先に**置く。**経過を見ると決めたものを
 * 埋もれさせない。** そのあとに取引先ごとの接点と入金を並べる。
 */
function followupContent(input: WeeklySectionsInput): string {
  const lines: string[] = [];

  for (const f of input.findings.filter((f) => f.status === "watching")) {
    lines.push(`経過を見ています: ${f.what}`);
  }

  const partners = input.partners ?? [];
  if (partners.length > 0) {
    if (lines.length > 0) lines.push("");
    for (const p of partners) {
      lines.push(row([p.name, p.contact, p.deposit ?? "入金なし"]));
    }
  }

  if (lines.length === 0) return "取引先ごとの動きは、まだ数えられていません。";
  return lines.join("\n");
}

/**
 * 「主要指標と時間の使い方」以下（内部の型は `stable_coverage`）。
 *
 * 発注 ③-3 で**5つの見出しをこの1つの型に入れる**と決めた。型を増やすと
 * `docs/spec/04_act.md` の構成順（5枠）と対応が取れなくなる。
 */
function stableCoverageContent(input: WeeklySectionsInput): string {
  const { summary } = input;
  const blocks: string[] = [];

  const metrics = input.metrics ?? [];
  if (metrics.length > 0) {
    blocks.push(
      [
        row(["指標", "今週", "前週", "過去8週の平均"]),
        ...metrics.map((m) => row([m.label, m.thisWeek, m.lastWeek, m.average8w])),
      ].join("\n"),
    );
  } else {
    blocks.push(
      summary.meetingCount === 0
        ? "集計できる予定がまだありません。"
        : `終日の予定は${summary.allDayCount}件。` +
            `${comparisonText("総会議時間", summary.meetingMinutesChange)}。`,
    );
  }

  const recurring = input.recurring ?? [];
  if (recurring.length > 0) {
    blocks.push(
      [
        "【定例会議・定期入金の状態】",
        ...recurring.map((r) =>
          row([r.label, `通常 ${r.usual}`, r.lastAt ? `最終 ${r.lastAt}` : "最終 なし", r.state]),
        ),
      ].join("\n"),
    );
  }

  if (input.outlook) blocks.push(`【見通し】\n${input.outlook}`);
  if (input.nextWeek) blocks.push(`【来週の予定】\n${input.nextWeek}`);

  blocks.push(`【連携済み・未連携のデータ】\n${sourceSummary(input)}`);

  return blocks.join("\n\n");
}

export function buildWeeklySections(input: WeeklySectionsInput): WeeklySection[] {
  return [
    { type: "digest", content: digestContent(input) },
    { type: "finding", content: findingContent(input) },
    { type: "followup", content: followupContent(input) },
    { type: "stable_coverage", content: stableCoverageContent(input) },
    {
      // **見出しを立てない**（発注 ③-3）。末尾に1行だけ
      type: "nudge",
      content: input.activeProviders.includes("google_calendar")
        ? ""
        : "Google カレンダーをつなぐと、会議の量と内訳が見えるようになります。",
    },
  ];
}
