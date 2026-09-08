/**
 * 連携の遷移を残す口（PS-9・マイグレーション `00032`）。
 *
 * **`connections` は現在の状態しか持たない。** `revoked_at` は再連携で NULL に戻るので、
 * **取り消しがあった事実そのものが消える。** 2026-09-03 の取り消しは 09-07 の再連携で
 * DB から消え、残っていたのはセッション記録と Edge のログだけだった。
 *
 * ここで固定するのは2つ。
 *   1. 書く行の形（列と CHECK の集合に合っていること）
 *   2. **Edge 側と Next.js 側が同じ挙動であること**（二重に持つので、ずれを機械で止める）
 */
import { describe, it, expect, vi } from "vitest";
import {
  recordConnectionEvent,
  type ConnectionEventInput,
} from "@/lib/connections/connection-events";
import * as edge from "@edge/_shared/connection-events";

/** `insert` に渡された行だけを覚える最小の偽物 */
function fakeDb(error: { message: string } | null = null) {
  const rows: Record<string, unknown>[] = [];
  const insert = vi.fn(async (row: Record<string, unknown>) => {
    rows.push(row);
    return { data: null, error };
  });
  return { rows, insert, from: vi.fn(() => ({ insert })) };
}

const revoked: ConnectionEventInput = {
  companyId: "c0000000-0000-4000-8000-000000000001",
  provider: "google_calendar",
  fromStatus: "active",
  toStatus: "revoked",
  reason: "invalid_grant",
};

describe("書く行の形", () => {
  it("connection_events に、列と同じ形の1行を書く", async () => {
    const db = fakeDb();
    const result = await recordConnectionEvent(db, revoked);

    expect(result).toEqual({ ok: true });
    expect(db.from).toHaveBeenCalledWith("connection_events");
    expect(db.rows[0]).toEqual({
      company_id: revoked.companyId,
      provider: "google_calendar",
      from_status: "active",
      to_status: "revoked",
      reason: "invalid_grant",
    });
  });

  it("遷移元が分からないときは null を書く（推測で埋めない）", async () => {
    const db = fakeDb();
    await recordConnectionEvent(db, { ...revoked, fromStatus: null });

    expect(db.rows[0].from_status).toBeNull();
  });

  it("**書けなくても throw しない**（記録の失敗をトークンの失敗に化けさせない）", async () => {
    const db = fakeDb({ message: "insert failed" });
    const result = await recordConnectionEvent(db, revoked);

    // **どこで失敗したかを文言に残す**（Edge 側の `takeError` と同じ形）
    expect(result).toEqual({ ok: false, error: "connection-events: insert: insert failed" });
  });
});

describe("Edge 側と Next.js 側がずれていない", () => {
  // Edge Function は supabase/functions の外を import できないため二重に持つ。
  // **片側だけ直すと、その経路の遷移だけ記録が落ちる**
  const cases: ConnectionEventInput[] = [
    revoked,
    { ...revoked, fromStatus: null, toStatus: "reauth_required", reason: "refresh_failed" },
    { ...revoked, fromStatus: "revoked", toStatus: "active", reason: "reconnected" },
    { ...revoked, toStatus: "reauth_required", reason: "vault_destroy_failed" },
  ];

  it.each(cases)(
    "同じ入力で同じ行を書く（to_status=$toStatus / reason=$reason）",
    async (input) => {
      const a = fakeDb();
      const b = fakeDb();

      expect(await recordConnectionEvent(a, input)).toEqual(
        await edge.recordConnectionEvent(b, input),
      );
      expect(a.rows).toEqual(b.rows);
    },
  );

  it("失敗の返し方も同じ", async () => {
    const a = fakeDb({ message: "boom" });
    const b = fakeDb({ message: "boom" });

    expect(await recordConnectionEvent(a, revoked)).toEqual(
      await edge.recordConnectionEvent(b, revoked),
    );
  });
});
