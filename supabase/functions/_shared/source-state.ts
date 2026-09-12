/**
 * データ源ごとの鮮度を判定する（PS-9c の改訂・2026-09-13）。**判断だけを持つ。**
 *
 * ## 何を直すか
 *
 * これまで配信の対象は**会社単位**で決めていた。Google カレンダーの連携が
 * `revoked` になると、その会社は「再連携のお願い」だけを受け取り、
 * **CSV 由来の処理（入出金の走査・`inflow` / `outflow` の平常値・入出金の本文）まで
 * 一緒に止まっていた。**
 *
 * 本番の実測（2026-09-12）では、CSV 59行を持つ会社が 09-08 に Google 連携を失って以来、
 * 毎回 `reconnect_suppressed` で終わり、**入出金の平常値が一度も確立していない。**
 *
 * ## PS-9c の改訂
 *
 * 旧: 取り込みが止まっている会社には `state-baselines` も `run-sense` も呼ばない。
 *
 * 新: **取り込みが止まっている源の値を、今の状態として提示しない。**
 * 源ごとに判定し、止まっている源は本文で「○月○日から取れていません」と明示する。
 *
 * **カレンダーが切れても、入出金の取り込みは止まっていない。** 源ごとに鮮度が違うので、
 * 会社単位で止めると、生きている源の値まで捨てることになる。
 *
 * ## Google だけを特別扱いしない
 *
 * CSV も同じ規則に乗せる。最後の取り込みから `CSV_STALE_DAYS` 日を過ぎたら
 * 「止まっている源」として扱う。月1回の取り込みを想定して 45日にしてある。
 */

/** CSV を「止まっている」とみなすまでの日数。**月1回の取り込みを想定** */
export const CSV_STALE_DAYS = 45;

const DAY_MS = 86_400_000;

/** 源の状態 */
export type SourceStatus =
  /** 今の状態として使ってよい */
  | "live"
  /** 取り込みが古い。**値を今の状態として出さない** */
  | "stale"
  /** 連携が切れている。**値を今の状態として出さず、再連携を案内する** */
  | "revoked";

export type SourceProvider = "google_calendar" | "csv:accounting" | "freee";

export interface SourceState {
  provider: SourceProvider;
  status: SourceStatus;
  /** 最後に取り込めた時刻。本文の「○月○日から取れていません」に使う */
  lastIngestedAt: string | null;
}

export interface SourceInput {
  /** `connections` の行（provider と status だけ） */
  connections: ReadonlyArray<{ provider: string; status: string; last_refresh?: string | null }>;
  /** 源ごとの最後の取り込み時刻（`events.ingested_at` の最大） */
  lastIngestedBySource: Readonly<Record<string, string | null | undefined>>;
  now: Date;
}

/**
 * 会社の源ごとの状態を決める。**持っていない源は返さない。**
 *
 * - 連携のある源（Google / freee）は `connections.status` で決める。
 *   `active` なら `live`、`revoked` / `reauth_required` なら `revoked`
 * - 連携の無い源（CSV）は最後の取り込みからの日数で決める
 */
export function sourceStates(input: SourceInput): SourceState[] {
  const out: SourceState[] = [];

  for (const provider of ["google_calendar", "freee"] as const) {
    const rows = input.connections.filter((c) => c.provider === provider);
    if (rows.length === 0) continue;

    const last = input.lastIngestedBySource[provider] ?? null;
    // **`active` が1つでもあれば生きている**（複数行ある場合の畳み方は dispatch と同じ）
    const status: SourceStatus = rows.some((r) => r.status === "active")
      ? "live"
      : rows.some((r) => r.status === "revoked" || r.status === "reauth_required")
        ? "revoked"
        : "stale";

    out.push({ provider, status, lastIngestedAt: last });
  }

  const csvLast = input.lastIngestedBySource["csv:accounting"] ?? null;
  if (csvLast) {
    const at = Date.parse(csvLast);
    const days = Number.isNaN(at) ? Number.POSITIVE_INFINITY : (input.now.getTime() - at) / DAY_MS;
    out.push({
      provider: "csv:accounting",
      status: days > CSV_STALE_DAYS ? "stale" : "live",
      lastIngestedAt: csvLast,
    });
  }

  return out;
}

/** 生きている源 */
export function liveSources(states: ReadonlyArray<SourceState>): SourceProvider[] {
  return states.filter((s) => s.status === "live").map((s) => s.provider);
}

/** 止まっている源（`stale` / `revoked`）。**本文に1行ずつ明示する** */
export function stoppedSources(states: ReadonlyArray<SourceState>): SourceState[] {
  return states.filter((s) => s.status !== "live");
}

/** 源の日本語名。本文に出す */
const SOURCE_LABELS: Record<SourceProvider, string> = {
  google_calendar: "カレンダー",
  "csv:accounting": "入出金",
  freee: "会計ソフト",
};

/**
 * 止まっている源の1行（PS-9c の改訂）。**見えているふりをしない。**
 *
 * 「カレンダーは 9月8日から取れていません（再連携はこちら）」。
 * 最後の取り込み時刻が分からなければ日付を書かない——**無い日付を作らない。**
 */
export function stoppedLine(state: SourceState): string {
  const label = SOURCE_LABELS[state.provider];
  const since = state.lastIngestedAt ? formatJaDate(state.lastIngestedAt) : null;
  const when = since ? `${since}から` : "";
  const action = state.status === "revoked" ? "（再連携はこちら）" : "（取り込みはこちら）";
  return `${label}は ${when}取れていません${action}`;
}

function formatJaDate(iso: string): string | null {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const jst = new Date(at + 9 * 60 * 60 * 1000);
  return `${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日`;
}

/**
 * その源に依存する処理を走らせてよいか。
 *
 * **Google 由来**（sync・予定の走査・`schedule_interval` の更新）は Google が `live` のときだけ。
 * **CSV 由来**（入出金の走査・`inflow` / `outflow` / `revenue` の平常値）は CSV が `live` のときだけ。
 */
export function canRun(states: ReadonlyArray<SourceState>, provider: SourceProvider): boolean {
  return states.some((s) => s.provider === provider && s.status === "live");
}
