import { describe, it, expect } from "vitest";
import {
  RETENTION_MONTHS,
  MAX_DELETE_ROWS,
  sourcesForProvider,
  retentionCutoff,
  evaluateDeletion,
  REVOKED_GRACE_DAYS,
  revokedCutoff,
  planPurge,
} from "@/lib/retention/policy";
import * as edge from "@edge/_shared/retention";

/**
 * プライバシーポリシー §6 で約束した削除を、実装が本当に守るかを固定する。
 *
 * **削除は「勝手に送らない」とは別方向の危険がある。** 消しすぎは取り返しがつかない。
 * 抽出条件（何を消す対象と見なすか）と、消しすぎを止める門を陽性・陰性の両方で固定する。
 * 「消えること」だけでなく **「消えないこと」** を必ず書く。
 */

describe("保持期間はポリシーの記述と一致する", () => {
  it("24ヶ月（privacy §6「取得した日から24ヶ月」）", () => {
    expect(RETENTION_MONTHS).toBe(24);
  });
});

describe("retentionCutoff — どこで線を引くか", () => {
  it("24ヶ月前の同日を返す", () => {
    expect(retentionCutoff(new Date("2026-08-20T00:00:00.000Z")).toISOString()).toBe(
      "2024-08-20T00:00:00.000Z",
    );
  });

  it("月末日でも桁溢れしない（3/31 の24ヶ月前は 3/31）", () => {
    expect(retentionCutoff(new Date("2026-03-31T12:00:00.000Z")).toISOString()).toBe(
      "2024-03-31T12:00:00.000Z",
    );
  });

  it("繰り上がりが起きる組み合わせでは月末に丸める（1ヶ月前の 3/31 は 2/29）", () => {
    // setMonth の桁溢れで 3/2 になる実装を弾く対照。24ヶ月では起きないが、
    // 月数を変えた瞬間に壊れる書き方を許さない
    expect(retentionCutoff(new Date("2024-03-31T00:00:00.000Z"), 1).toISOString()).toBe(
      "2024-02-29T00:00:00.000Z",
    );
  });

  it("うるう年でない年は 2/28 に丸める", () => {
    expect(retentionCutoff(new Date("2026-03-31T00:00:00.000Z"), 1).toISOString()).toBe(
      "2026-02-28T00:00:00.000Z",
    );
  });
});

describe("sourcesForProvider — 抽出条件（陽性・陰性）", () => {
  it("google_calendar 由来の source だけを返す", () => {
    expect(sourcesForProvider("google_calendar")).toEqual(["google_calendar"]);
  });

  it("freee は freee のみ", () => {
    expect(sourcesForProvider("freee")).toEqual(["freee"]);
  });

  it("google_calendar の解除で他の取り込み元を巻き込まない", () => {
    // 陰性コントロール。ここが緩いと、解除のたびに CSV や freee まで消える
    expect(sourcesForProvider("google_calendar")).not.toContain("csv:accounting");
    expect(sourcesForProvider("google_calendar")).not.toContain("freee");
  });

  it("未知の provider では空を返す（＝1行も消さない）", () => {
    // fail-closed。知らない provider を「全部消す」に丸めない
    expect(sourcesForProvider("unknown_provider")).toEqual([]);
    expect(sourcesForProvider("")).toEqual([]);
  });
});

describe("evaluateDeletion — 消しすぎを止める門", () => {
  const companyId = "11111111-1111-4111-8111-111111111111";

  it("想定内なら通す", () => {
    expect(evaluateDeletion({ companyId, counted: 10, max: 5000 })).toEqual({
      ok: true,
      count: 10,
    });
  });

  it("0件でも通す（no-op）", () => {
    expect(evaluateDeletion({ companyId, counted: 0, max: 5000 })).toEqual({ ok: true, count: 0 });
  });

  it("上限ちょうどは通す", () => {
    expect(evaluateDeletion({ companyId, counted: 5000, max: 5000 })).toEqual({
      ok: true,
      count: 5000,
    });
  });

  it("上限を超えたら止める。消さない", () => {
    expect(evaluateDeletion({ companyId, counted: 5001, max: 5000 })).toEqual({
      ok: false,
      reason: "over-limit",
      count: 5001,
    });
  });

  it("company_id が無ければ止める（全社削除を構造的に塞ぐ）", () => {
    // 陰性コントロール。ここが通ると1回の事故で全社のデータが消える
    expect(evaluateDeletion({ companyId: "", counted: 1, max: 5000 })).toEqual({
      ok: false,
      reason: "unscoped",
      count: 1,
    });
  });

  it("company_id が空白のみでも止める", () => {
    expect(evaluateDeletion({ companyId: "   ", counted: 1, max: 5000 })).toEqual({
      ok: false,
      reason: "unscoped",
      count: 1,
    });
  });

  it("件数が数えられなかった場合は止める（null を0に丸めない）", () => {
    // 予算行の fail-closed（S-6-2）と同じ考え方。「数えられなかった＝0件＝安全」に
    // 丸めると、数え損ねた瞬間に門が無くなる
    expect(evaluateDeletion({ companyId, counted: null, max: 5000 })).toEqual({
      ok: false,
      reason: "uncounted",
      count: 0,
    });
  });
});

describe("D-3: 取り消しから30日（陽性・陰性）", () => {
  const now = new Date("2026-09-08T00:00:00.000Z");
  const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);

  it("猶予は30日（契約D の D-3）", () => {
    expect(REVOKED_GRACE_DAYS).toBe(30);
  });

  it("D-3-1（陰性コントロール）: 30日**未満**は対象にならない", () => {
    const cutoff = revokedCutoff(now);
    // `revoked_at > cutoff` が「まだ消さない」側である
    expect(daysAgo(29).getTime()).toBeGreaterThan(cutoff.getTime());
    expect(daysAgo(1).getTime()).toBeGreaterThan(cutoff.getTime());
  });

  it("D-3-2（陽性）: 30日**以上**経過は対象になる", () => {
    const cutoff = revokedCutoff(now);
    expect(daysAgo(30).getTime()).toBeLessThanOrEqual(cutoff.getTime());
    expect(daysAgo(31).getTime()).toBeLessThan(cutoff.getTime());
  });
});

describe("planPurge — 消すか、数えるだけか", () => {
  const base = { companyId: "c", max: 10 };

  it("既定の安全側: dryRun なら数えるだけで、削除の判断に落ちない", () => {
    expect(planPurge({ ...base, counted: 3, dryRun: true })).toEqual({
      decision: "dry_run",
      count: 3,
    });
  });

  it("dryRun でなければ削除の判断になる", () => {
    expect(planPurge({ ...base, counted: 3, dryRun: false })).toEqual({
      decision: "deleted",
      count: 3,
    });
  });

  it("0件は削除にも dry_run にもしない（区別できる形で返す）", () => {
    expect(planPurge({ ...base, counted: 0, dryRun: false })).toEqual({
      decision: "nothing",
      count: 0,
    });
  });

  it("D-3-3（陰性コントロール）: 上限超過は dryRun でなくても止まる", () => {
    expect(planPurge({ ...base, counted: 11, dryRun: false })).toEqual({
      decision: "blocked",
      reason: "over-limit",
      count: 11,
    });
  });

  it("D-3-3（陰性コントロール）: 数えられなければ止まる。**null を 0 に丸めない**", () => {
    expect(planPurge({ ...base, counted: null, dryRun: false })).toEqual({
      decision: "blocked",
      reason: "uncounted",
      count: 0,
    });
  });

  it("D-3-4（陰性コントロール）: company_id が取れなければ止まる", () => {
    expect(planPurge({ ...base, companyId: "", counted: 3, dryRun: false })).toEqual({
      decision: "blocked",
      reason: "unscoped",
      count: 3,
    });
  });

  it("**止まるときは dryRun かどうかで結果が変わらない**（門は常に効く）", () => {
    for (const counted of [11, null]) {
      expect(planPurge({ ...base, counted, dryRun: true })).toEqual(
        planPurge({ ...base, counted, dryRun: false }),
      );
    }
  });
});

describe("Edge 側と Next.js 側でポリシーがずれていない", () => {
  // Edge Function は supabase/functions の外を import できないため、保持期間は
  // _shared/retention.ts にも要る。二重に持つ以上、ずれを機械で止める
  it("RETENTION_MONTHS が一致する", () => {
    expect(edge.RETENTION_MONTHS).toBe(RETENTION_MONTHS);
  });

  it("MAX_DELETE_ROWS が一致する", () => {
    expect(edge.MAX_DELETE_ROWS).toBe(MAX_DELETE_ROWS);
  });

  it("retentionCutoff が同じ値を返す", () => {
    for (const iso of ["2026-08-20T00:00:00.000Z", "2026-03-31T12:00:00.000Z"]) {
      expect(edge.retentionCutoff(new Date(iso)).toISOString()).toBe(
        retentionCutoff(new Date(iso)).toISOString(),
      );
    }
  });

  it("evaluateDeletion が同じ判定を返す", () => {
    const cases = [
      { companyId: "c", counted: 1, max: 10 },
      { companyId: "c", counted: 11, max: 10 },
      { companyId: "", counted: 1, max: 10 },
      { companyId: "c", counted: null, max: 10 },
    ];
    for (const c of cases) expect(edge.evaluateDeletion(c)).toEqual(evaluateDeletion(c));
  });

  it("REVOKED_GRACE_DAYS が一致する（D-3-5）", () => {
    expect(edge.REVOKED_GRACE_DAYS).toBe(REVOKED_GRACE_DAYS);
  });

  it("revokedCutoff が同じ値を返す", () => {
    for (const iso of ["2026-09-08T00:00:00.000Z", "2026-01-01T09:00:00.000Z"]) {
      expect(edge.revokedCutoff(new Date(iso)).toISOString()).toBe(
        revokedCutoff(new Date(iso)).toISOString(),
      );
    }
  });

  it("planPurge が同じ判断を返す", () => {
    const cases = [
      { companyId: "c", counted: 3, max: 10, dryRun: false },
      { companyId: "c", counted: 3, max: 10, dryRun: true },
      { companyId: "c", counted: 11, max: 10, dryRun: false },
      { companyId: "c", counted: null, max: 10, dryRun: true },
      { companyId: "", counted: 1, max: 10, dryRun: false },
    ];
    for (const c of cases) expect(edge.planPurge(c)).toEqual(planPurge(c));
  });

  it("sourcesForProvider が同じ対応を返す（**片側だけ増えない**）", () => {
    for (const provider of ["google_calendar", "freee", "unknown", ""]) {
      expect(edge.sourcesForProvider(provider)).toEqual(sourcesForProvider(provider));
    }
  });
});
