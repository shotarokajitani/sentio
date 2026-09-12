/**
 * 配信を途中から再開する（発注 ⑥J-4）。
 *
 * ## 何が起きていたか
 *
 * `dispatch-daily` は**全社を1回のリクエストで回している。** 記録を書くのは
 * 全部終わったあとなので、**時間切れで落ちると1行も残らない。**
 * 翌朝の実行は最初からやり直し、そこでも落ちれば同じことが起きる。
 *
 * **会社が増えるほど落ちやすくなり、増えたぶんだけ後ろの会社が届かなくなる。**
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  COMPANY_TIMEOUT_MS,
  RESUMABLE_OUTCOMES,
  RUN_DEADLINE_MS,
  planResume,
  runKeyOf,
  shouldStopForDeadline,
  type ResumeRow,
} from "@edge/_shared/dispatch-resume";

const row = (over: Partial<ResumeRow> = {}): ResumeRow => ({
  company_id: "c1",
  outcome: "pending",
  finished_at: null,
  ...over,
});

describe("再開で拾う会社を決める", () => {
  it("pending / running / timeout の3つを拾う", () => {
    const rows = RESUMABLE_OUTCOMES.map((o, i) => row({ company_id: `c${i}`, outcome: o }));
    expect(planResume(rows)).toEqual(["c0", "c1", "c2"]);
  });

  it("**陰性**: 終わった会社は拾わない（2通目を出さない）", () => {
    const done = row({ outcome: "delivered", finished_at: "2026-09-10T22:05:00.000Z" });
    expect(planResume([done])).toEqual([]);
  });

  it("**陰性**: `finished_at` が入っていれば、結末が何であれ拾わない", () => {
    // `failed_deliver` も「試して駄目だった」であって、同じ日に何度も試す理由が無い
    for (const outcome of ["failed_deliver", "skipped_no_connection", "timeout"]) {
      const r = row({ outcome, finished_at: "2026-09-10T22:05:00.000Z" });
      expect(planResume([r]), outcome).toEqual([]);
    }
  });

  it("**陰性**: 知らない結末は拾わない（fail-closed）", () => {
    expect(planResume([row({ outcome: "なにか", finished_at: null })])).toEqual([]);
    expect(planResume([row({ outcome: null })])).toEqual([]);
  });

  it("company_id が無い行（kind='run'）は対象外", () => {
    expect(planResume([row({ company_id: null })])).toEqual([]);
  });
});

describe("締切に達したら、始めずに残す", () => {
  it("残り時間が1社分に満たなければ止める", () => {
    const start = 0;
    expect(shouldStopForDeadline(start, RUN_DEADLINE_MS - COMPANY_TIMEOUT_MS)).toBe(true);
  });

  it("**陰性**: まだ1社分の余裕があれば続ける", () => {
    expect(shouldStopForDeadline(0, RUN_DEADLINE_MS - COMPANY_TIMEOUT_MS - 1)).toBe(false);
  });

  it("**始めてから切らない。** 始めなければ pending のままで「触っていない」と言える", () => {
    // 全体 300 秒より 90 秒手前で降りる。上限で殺されると running が残る
    expect(RUN_DEADLINE_MS).toBe(300_000);
    expect(COMPANY_TIMEOUT_MS).toBe(90_000);
    expect(RUN_DEADLINE_MS).toBeGreaterThan(COMPANY_TIMEOUT_MS);
  });
});

describe("実行の鍵は JST で決める", () => {
  it("daily は JST の日付", () => {
    // UTC 22:00 = JST 翌 07:00
    expect(runKeyOf({ kind: "daily", now: new Date("2026-09-10T22:00:00Z") })).toBe("2026-09-11");
  });

  it("**陰性**: 22:15 の再開が、22:00 の本体と同じ鍵になる（前日の行を拾わない）", () => {
    const main = runKeyOf({ kind: "daily", now: new Date("2026-09-10T22:00:00Z") });
    const resume = runKeyOf({ kind: "daily", now: new Date("2026-09-10T23:00:00Z") });
    expect(resume).toBe(main);
  });

  it("weekly は ISO 週（日付にすると月曜の再開が日曜の行を拾えない）", () => {
    // 2026-09-13 は日曜。UTC 23:00 = JST 月曜 08:00
    const key = runKeyOf({ kind: "weekly", now: new Date("2026-09-13T23:00:00Z") });
    expect(key).toMatch(/^\d{4}-W\d{2}$/);
  });
});

/**
 * 「まだ始めていない」と「全部終わった」を分ける（2026-09-12 の実測で追加）。
 *
 * **未完了が0件であることは、両方を意味する。** 区別できないと、
 * 22:15 / 22:30 / 22:45 / 23:00 の再開 cron が**毎回3社を最初からやり直す。**
 * 本番のログで `run-sense` / `scan` / `state-baselines` / `deliver-pulse` が
 * 毎朝5回走っていた。二重送信は `delivery_log` の冪等キー（23505）が
 * 止めていただけで、**枠と時間は5倍使っていた。**
 */
describe("初回と再開を取り違えない", () => {
  const dispatch = readFileSync(
    path.resolve(__dirname, "../../supabase/functions/_shared/dispatch.ts"),
    "utf8",
  );

  it("行が1行も無いことを初回の条件にする", () => {
    expect(dispatch).toContain("const isFirstRun = state.total === 0;");
  });

  it("**陰性**: 未完了の件数で初回を決めない", () => {
    // これが元の実装。**予約が失敗していたので常に0件**になり、
    // 毎回「初回」と判定されていた
    expect(dispatch).not.toContain("stillOpen.size === 0");
  });

  it("進み具合は total と unfinished を別々に受け取る", () => {
    expect(dispatch).toContain("listRunState?(runKey: string)");
    expect(dispatch).toContain("{ total: number; unfinished: string[] } | null");
  });

  it("**陰性**: 引けなかったときは再開の絞り込みをしない（0件と混ぜない）", () => {
    expect(dispatch).toContain("if (state !== null && state !== undefined) {");
  });
});

describe("配信側の配線", () => {
  const dispatch = readFileSync(
    path.resolve(__dirname, "../../supabase/functions/_shared/dispatch.ts"),
    "utf8",
  );
  const runtime = readFileSync(
    path.resolve(__dirname, "../../supabase/functions/_shared/dispatch-runtime.ts"),
    "utf8",
  );

  it("pending の予約が、会社を回す前にある", () => {
    const reserve = dispatch.indexOf("deps.reservePending!");
    const loop = dispatch.indexOf("for (const target of pending)");
    expect(reserve).toBeGreaterThan(-1);
    expect(reserve).toBeLessThan(loop);
  });

  it("B の掃除が先頭に残っている（この PR で消していない）", () => {
    const sweep = dispatch.indexOf("deps.sweepStaleSending");
    const reserve = dispatch.indexOf("deps.reservePending!");
    expect(sweep).toBeGreaterThan(-1);
    expect(sweep).toBeLessThan(reserve);
  });

  it("1社の結末をその場で確定する（**まとめて書くと落ちた社が消える**）", () => {
    expect(dispatch).toContain("await deps.finishCompany(runKey, companyId, outcome, reason");
  });

  it("時間切れは `finished_at` を入れない（次の再開で拾い直す）", () => {
    expect(dispatch).toContain(
      'await settle(target.companyId, "timeout", "deliver_timeout", false)',
    );
    expect(runtime).toContain("finished_at: finished ? new Date().toISOString() : null");
  });

  it("会社ごとの呼び出しに 90 秒の締切が付く", () => {
    expect(runtime).toContain("AbortSignal.timeout(COMPANY_TIMEOUT_MS)");
  });

  it("**陰性**: 時間切れを「送れなかった」と混ぜない", () => {
    // 相手が生きている可能性があり、次の再開でもう一度試す価値がある
    expect(dispatch).toContain("delivered.status === 0");
    expect(dispatch).toContain("summary.timed_out++");
  });

  it("要約に再開の数字が出る（**0件でも必ず出す**）", () => {
    expect(dispatch).toContain("deferred_by_deadline: 0");
    expect(dispatch).toContain("timed_out: 0");
  });

  it("予約は冪等（終わった会社を pending へ戻さない）", () => {
    expect(runtime).toContain("ignoreDuplicates: true");
  });
});
