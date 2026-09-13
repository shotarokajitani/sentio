/**
 * 状態パケットの材料を実DBから読む（発注書 ①-a）。
 *
 * **組み立て（`state-packet.ts`）と読み取り（ここ）を分ける。**
 * 組み立て側を純粋にしておかないと、9項目の中身を試験で固定できない
 * （`retention.ts` と `retention-purge/index.ts` の関係と同じ形）。
 *
 * **LLM は1度も呼ばない。** ここが読むのは `connections` / `events` / `baselines` の3つだけである。
 */

import { mustCount, mustData } from "./db.ts";
import { jstDateKey } from "./jst.ts";
import type {
  PacketBaselineRow,
  PacketConnection,
  PacketEvent,
  PacketInput,
} from "./state-packet.ts";

/**
 * 1回のパケットで読むイベントの上限。
 *
 * **超えたら組まない**（`packet_build_failed`）。PostgREST は既定で1000行に切るので、
 * 黙って一部だけで組むと**「9項目が全部埋まった正しそうなパケット」が出てしまう。**
 * 数え切れない量になったら、そのことを記録して止める方が安全である。
 */
export const PACKET_EVENT_LIMIT = 5000;

/** 材料が読めなかった理由。**HTTP 200 で終わらせないための値** */
export class PacketSourceError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "PacketSourceError";
  }
}

interface QueryError {
  message: string;
  code?: string;
}

/** 行を返すクエリ。`mustData` が受け取れる形にしてある */
interface Rows<T> extends PromiseLike<{ data: T | null; error: QueryError | null }> {
  eq(column: string, value: string): Rows<T>;
  order(column: string, options: { ascending: boolean }): Rows<T>;
  limit(n: number): Rows<T>;
}

/** 件数だけを返すクエリ。`mustCount` が受け取れる形にしてある */
interface Counted extends PromiseLike<{
  data: unknown;
  error: QueryError | null;
  count: number | null;
}> {
  eq(column: string, value: string): Counted;
}

/**
 * `events` / `connections` / `baselines` を読むのに要る最小限だけを型にしてある。
 *
 * `delivery.ts` の `asDeliveryDb` と同じ理由の境界である。実クライアントの総称型と
 * 関係付けようとすると `deno check` が `TS2589` で落ちるため、ここで1回だけキャストする。
 * **噛み合わせは実物（統合テストと本番）で見る。**
 */
export interface PacketDb {
  from(table: string): {
    select<T>(columns: string): Rows<T>;
    select(columns: string, options: { count: "exact"; head: true }): Counted;
  };
}

export function asPacketDb(client: unknown): PacketDb {
  return client as PacketDb;
}

/** 材料を読む。**読めなかったら組まない**（理由を持って落ちる） */
export async function loadPacketInput(
  supabase: unknown,
  companyId: string,
  now: Date,
  /**
   * 止まっている源（PS-9c の改訂）。**その源のイベントを材料に入れない。**
   *
   * 取り込みが止まっている源の値を、今の状態として提示しないためである。
   * 件数の上限判定は除外する前の全件で行う——**上限の意味を変えない。**
   */
  excludeSources: readonly string[] = [],
): Promise<PacketInput> {
  const db = asPacketDb(supabase);

  const eventCount = await mustCount(
    db
      .from("events")
      .select("event_id", { count: "exact", head: true })
      .eq("company_id", companyId),
    "state-packet: events count",
  );

  if (eventCount > PACKET_EVENT_LIMIT) {
    // **一部だけで組まない。** 途中まで正しいパケットが一番たちが悪い
    throw new PacketSourceError(
      "events_over_limit",
      `イベントが ${eventCount} 件で上限 ${PACKET_EVENT_LIMIT} を超えた`,
    );
  }

  const allEvents = await mustData<PacketEvent[]>(
    db
      .from("events")
      .select<PacketEvent[]>(
        "event_id, source, event_type, occurred_at, ingested_at, metrics, sensitivity",
      )
      .eq("company_id", companyId)
      .order("occurred_at", { ascending: true })
      .limit(PACKET_EVENT_LIMIT),
    "state-packet: events",
  );
  // **止まっている源の値を材料に入れない**（PS-9c の改訂・fail-closed）
  const excluded = new Set(excludeSources);
  const events = excluded.size === 0 ? allEvents : allEvents.filter((e) => !excluded.has(e.source));

  const connections = await mustData<PacketConnection[]>(
    db
      .from("connections")
      .select<PacketConnection[]>("provider, status, expires_at, last_refresh, revoked_at")
      .eq("company_id", companyId),
    "state-packet: connections",
  );

  const baselines = await mustData<PacketBaselineRow[]>(
    db
      .from("baselines")
      .select<PacketBaselineRow[]>("metric_key, is_established, min_obs, stats")
      .eq("company_id", companyId),
    "state-packet: baselines",
  );

  return {
    generatedAt: now,
    // 報告対象日は**当日**（いつ時点の状態かを書く面なので、前日ではない）
    reportDate: jstDateKey(now),
    connections,
    events,
    baselines,
  };
}
