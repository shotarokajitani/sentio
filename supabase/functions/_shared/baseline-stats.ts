/**
 * baselines の表現を1つに固定する（契約 S-1-2 / P-3）。
 *
 * 修復前、baseline の形は**3種類**併存していた。
 *
 * | 場所                        | 形                                                            | DBと一致 |
 * | --------------------------- | ------------------------------------------------------------- | -------- |
 * | `00003`（実スキーマ）       | `stats` JSONB                                                 | —        |
 * | `src/state/baselines.ts`    | `{ is_established, stats: { median, iqr, p25, p75, count } }` | **一致** |
 * | `src/sense/scanner.ts`      | フラットな `{ median, iqr, p25, p75, count }`                 | 不一致   |
 * | `state-baselines`（Edge）   | フラット（**列として書く**）                                  | 不一致   |
 *
 * **この3者を繋ぐ変換アダプタはリポジトリ内に1つも存在しなかった。**
 * Edge Function は実在しない列（`median` / `iqr` / `p25` / `p75` /
 * `observation_count`）を書き、`PGRST204` になっていた。
 *
 * **正本は DB の `stats` JSONB**。フラット形へはこのファイルの `toFlatBaseline()`
 * だけを通って到達する。**変換をここ以外に書かないこと。**
 * 各所で `row.median` と書き始めた瞬間に、また3種類に戻る。
 */

/** `baselines.stats` JSONB の中身。**これが正本の形。** */
import { jstDateKey } from "./jst.ts";

export interface BaselineStats {
  median: number;
  iqr: number;
  p25: number;
  p75: number;
  count: number;
}

/** `baselines` の行のうち、走査が使う部分。 */
export interface BaselineRow {
  metric_key: string;
  is_established: boolean;
  stats: unknown;
}

/**
 * 走査側（`src/sense/scanner.ts` の `Baseline`）が使うフラット形。
 * **DBには存在しない形である。** 比較のためだけに存在する。
 */
export interface FlatBaseline extends BaselineStats {
  metric_key: string;
  is_established: boolean;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * `stats` JSONB を数値として取り出す。
 *
 * **欠けていたら `null` を返す。0 で埋めない。** 埋めると
 * 「基準値が0」として比較が走り、あらゆるイベントが乖離として検出される。
 * 修復前に `undefined` が入って比較が `NaN` になり**静かに0件**になっていたのと、
 * 向きが逆なだけで同じ質の事故になる。
 */
export function parseBaselineStats(stats: unknown): BaselineStats | null {
  if (stats === null || typeof stats !== "object") return null;
  const s = stats as Record<string, unknown>;

  if (
    !isFiniteNumber(s.median) ||
    !isFiniteNumber(s.iqr) ||
    !isFiniteNumber(s.p25) ||
    !isFiniteNumber(s.p75) ||
    !isFiniteNumber(s.count)
  ) {
    return null;
  }

  return { median: s.median, iqr: s.iqr, p25: s.p25, p75: s.p75, count: s.count };
}

/**
 * DB の行を走査側のフラット形へ変換する。**唯一の変換経路。**
 * `stats` が読めない行は `null` を返す（呼び出し元が落とす）。
 */
export function toFlatBaseline(row: BaselineRow): FlatBaseline | null {
  const stats = parseBaselineStats(row.stats);
  if (!stats) return null;
  return { metric_key: row.metric_key, is_established: row.is_established, ...stats };
}

/** 行の配列をまとめて変換する。`stats` が読めない行は落とす。 */
export function toFlatBaselines(rows: readonly BaselineRow[]): FlatBaseline[] {
  return rows.map(toFlatBaseline).filter((b): b is FlatBaseline => b !== null);
}

/**
 * 観測値から `stats` を作る。`state-baselines` が書く値の唯一の出所。
 * **確立していない（観測数が足りない）場合は `null`。** 空オブジェクトを書かない
 * （`{}` は `parseBaselineStats` で `null` になるので、読み側で必ず落ちる）。
 */
export function buildBaselineStats(
  observations: readonly number[],
  minObs: number,
): BaselineStats | null {
  if (observations.length < minObs) return null;

  const sorted = [...observations].sort((a, b) => a - b);
  const median =
    sorted.length % 2 === 1
      ? sorted[Math.floor(sorted.length / 2)]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

  const p25 = percentile(sorted, 25);
  const p75 = percentile(sorted, 75);

  return { median, iqr: p75 - p25, p25, p75, count: observations.length };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

/**
 * `state-baselines` が計算する baseline の同定情報。
 *
 * `granularity` を `"event"` にしているのは、この baseline が**個々の取引イベントの
 * `metrics.revenue` を1観測として集めたもの**で、月次・週次のような集計期間を
 * 持たないからである。`00003` の `granularity` は NOT NULL なので何かは入れる必要があり、
 * 実態と違う `"monthly"` を入れると、後から期間集計の baseline を足したときに
 * **同じキーで別物を上書きする**。
 *
 * `entity_id` は `null`（会社全体の売上であってエンティティ単位ではない）。
 * 自然キー `(company_id, metric_key, entity_id, granularity)` の一部なので、
 * 明示的に `null` を書く（省略すると列が既定値になり、キーの意味が変わる）。
 */
export const REVENUE_BASELINE = {
  metricKey: "revenue",
  granularity: "event",
  entityId: null,
} as const;

/** `baselines` の自然キー。`00023` の一意索引と同じ順・同じ列（契約 S-方針1 / S-D2）。 */
export const BASELINE_NATURAL_KEY = "company_id,metric_key,entity_id,granularity";

/**
 * 予定の発生間隔のベースライン（途絶＝沈黙シグナルの土台）。
 *
 * `entity_id` は `null`、すなわち**会社全体**の予定間隔である。
 * 仕様（`docs/spec/02_state.md`）は「指標×エンティティ(任意)×粒度」を許しており、
 * 定例シリーズごとに持つのが本来の形だが、`entity_id` は UUID で
 * `entities` 行の生成（シリーズの同定キーの決定）が要る。
 * **まず会社全体で作る**（2026-08-31 梶谷さん判断）。限界は `scan.ts` に明記した。
 */
export const SCHEDULE_INTERVAL_BASELINE = {
  metricKey: "schedule_interval",
  granularity: "event",
  entityId: null,
} as const;

/**
 * 予定が入っている「**日**」の間隔（日数）を返す。
 *
 * **同じ日に何件予定があっても1日と数える。** イベントごとの間隔をそのまま使うと、
 * 1日に複数の会議がある会社で中央値が 0 日になり、**あらゆる空白が途絶に見える**。
 * 日単位に丸めることでそれを構造的に防ぐ。
 *
 * 日の境界は JST（`jstDateKey`）。Sentio の日次キーは例外なく JST 基準である。
 */
export function scheduleDayIntervals(occurredAt: readonly string[]): number[] {
  const days = [...new Set(occurredAt.map((iso) => jstDateKey(new Date(iso))))].sort();
  const intervals: number[] = [];
  for (let i = 1; i < days.length; i++) {
    const diff = Date.parse(`${days[i]}T00:00:00Z`) - Date.parse(`${days[i - 1]}T00:00:00Z`);
    intervals.push(Math.round(diff / (24 * 60 * 60 * 1000)));
  }
  return intervals;
}
