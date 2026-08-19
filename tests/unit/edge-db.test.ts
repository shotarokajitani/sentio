import { describe, it, expect } from "vitest";
import {
  mustData,
  mustMaybe,
  mustCount,
  mustOk,
  takeError,
  DbError,
  isDbError,
} from "@edge/_shared/db";

/**
 * S-2-1 / S-2-2 / S-2-3: DBエラーを握りつぶさない共通経路。
 *
 * 要点は3つ。
 * 1. `error` があれば **必ず throw**（既定値を返して 200 で終わらない）
 * 2. **0件は正常系**。空配列も null も、エラーが無ければそのまま通す
 * 3. throw されたエラーから **どのクエリで落ちたか** が分かる（context）
 */

const ok = <T>(data: T) => Promise.resolve({ data, error: null });
const ng = (message: string, code?: string) =>
  Promise.resolve({ data: null, error: { message, code } });

describe("mustData", () => {
  it("error が無ければ data をそのまま返す", async () => {
    await expect(mustData(ok([{ id: 1 }]), "ctx")).resolves.toEqual([{ id: 1 }]);
  });

  it("0件（空配列）はエラーにしない — 0件は正常系 (S-2-3)", async () => {
    await expect(mustData(ok([]), "ctx")).resolves.toEqual([]);
  });

  it("maybeSingle の 0件（null）もエラーにしない", async () => {
    await expect(mustData(ok(null), "ctx")).resolves.toBeNull();
  });

  it("error があれば throw する — 既定値を返して正常終了しない (S-2-2)", async () => {
    await expect(mustData(ng('column "median" does not exist', "42703"), "ctx")).rejects.toThrow(
      DbError,
    );
  });

  it("throw されたエラーに context と PostgreSQL のコードが載る", async () => {
    try {
      await mustData(ng('column "median" does not exist', "42703"), "state-baselines: baselines");
      throw new Error("throw されなかった");
    } catch (e) {
      expect(isDbError(e)).toBe(true);
      const err = e as DbError;
      expect(err.context).toBe("state-baselines: baselines");
      expect(err.code).toBe("42703");
      expect(err.message).toContain("state-baselines: baselines");
      expect(err.message).toContain("42703");
    }
  });

  it("コードの無いエラーでも throw する", async () => {
    await expect(mustData(ng("network unreachable"), "ctx")).rejects.toThrow(DbError);
  });
});

describe("mustOk", () => {
  it("error が無ければ何も投げない", async () => {
    await expect(mustOk(ok(null), "ctx")).resolves.toBeUndefined();
  });

  it("error があれば throw する", async () => {
    await expect(mustOk(ng("duplicate key", "23505"), "ctx")).rejects.toThrow(DbError);
  });
});

describe("DbError を 5xx に変換する", () => {
  it("isDbError で catch 側が判別できる", () => {
    expect(isDbError(new DbError("ctx", "boom", "42703"))).toBe(true);
    expect(isDbError(new Error("boom"))).toBe(false);
    expect(isDbError(null)).toBe(false);
  });

  it("エラー本文に秘密が載る余地を作らない（context と message と code のみ）", () => {
    const err = new DbError("ctx", "boom", "42703");
    expect(Object.keys(err)).toEqual(expect.arrayContaining(["context", "code"]));
    expect(JSON.stringify({ ...err })).not.toContain("service_role");
  });
});

describe("takeError — throw が正しくない場所のための第3の形", () => {
  it("error が無ければ null を返す", async () => {
    await expect(takeError(ok(null), "ctx")).resolves.toBeNull();
  });

  it("error があれば throw せず DbError を値として返す", async () => {
    const err = await takeError(ng("connection update failed", "23503"), "token-refresh: conn");

    expect(err).toBeInstanceOf(DbError);
    expect(err!.context).toBe("token-refresh: conn");
    expect(err!.code).toBe("23503");
  });
});

/**
 * `mustData` と `mustMaybe` を分けている理由（2026-08-19 の CI `deno check` 実測）。
 *
 * PostgREST の応答は `{data: Row[]; error: null} | {data: null; error: PostgrestError}` の合併で、
 * `data: T` のまま受けると `T` が `Row[] | null` に推論され、**全呼び出し元が
 * 「possibly null」の型エラー**になった（28件）。`data: T | null` から null を落として
 * 推論させることで解決するが、その形だと `maybeSingle()` の 0件（null）まで
 * 型から消えてしまい、**0件とエラーの区別（S-2-3）が型のレベルで壊れる**。
 * よって単一行の取得は `mustMaybe` に分け、`null` を返り値の型に残す。
 */
describe("mustMaybe", () => {
  it("0件（null）をそのまま返す — 0件は正常系 (S-2-3)", async () => {
    await expect(mustMaybe(ok(null), "ctx")).resolves.toBeNull();
  });

  it("行があればそのまま返す", async () => {
    await expect(mustMaybe(ok({ id: 1 }), "ctx")).resolves.toEqual({ id: 1 });
  });

  it("error があれば throw する（0件と区別する）", async () => {
    await expect(mustMaybe(ng("permission denied", "42501"), "ctx")).rejects.toThrow(DbError);
  });
});

describe("mustCount", () => {
  const counted = (count: number | null) => Promise.resolve({ data: null, error: null, count });

  it("count をそのまま返す", async () => {
    await expect(mustCount(counted(7), "ctx")).resolves.toBe(7);
  });

  it("count が null なら 0 として扱う（head:true の 0件）", async () => {
    await expect(mustCount(counted(null), "ctx")).resolves.toBe(0);
  });

  it("error があれば throw する（0件に丸めない）", async () => {
    const failed = Promise.resolve({
      data: null,
      error: { message: 'relation "events" does not exist', code: "42P01" },
      count: null,
    });
    await expect(mustCount(failed, "ctx")).rejects.toThrow(DbError);
  });
});
