/**
 * データ源ごとの鮮度で配信を決める（PS-9c の改訂・2026-09-13）。
 *
 * ## 何が起きていたか
 *
 * 配信の対象を**会社単位**で決めていた。Google カレンダーの連携が `revoked` になると、
 * その会社は「再連携のお願い」だけを受け取り、**CSV 由来の処理まで一緒に止まっていた。**
 *
 * 本番の実測（2026-09-12）では、CSV 59行を持つ会社が 09-08 に Google 連携を失って以来、
 * 毎回 `reconnect_suppressed` で終わり、**入出金の平常値が一度も確立していない。**
 *
 * カレンダーが切れても、入出金の取り込みは止まっていない。
 * **源ごとに鮮度が違うので、会社単位で止めると生きている源の値まで捨てる。**
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CSV_STALE_DAYS,
  canRun,
  liveSources,
  sourceStates,
  stoppedLine,
  stoppedSources,
} from "@edge/_shared/source-state";
import { planCompany, runDispatch, type CompanyTarget } from "@edge/_shared/dispatch";

const NOW = new Date("2026-09-13T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function target(over: Partial<CompanyTarget> = {}): CompanyTarget {
  return {
    companyId: "ab73e516-0000-0000-0000-000000000000",
    email: "owner@example.com",
    connectionState: "revoked",
    lastReconnectNoticeAt: daysAgo(2),
    detectedAt: daysAgo(5),
    subscriptionStatus: "active",
    ...over,
  };
}

describe("源ごとの状態を決める", () => {
  it("Google が revoked、CSV が最近取り込み済み → カレンダーは止まり、入出金は生きている", () => {
    const states = sourceStates({
      connections: [{ provider: "google_calendar", status: "revoked" }],
      lastIngestedBySource: { google_calendar: daysAgo(5), "csv:accounting": daysAgo(3) },
      now: NOW,
    });

    expect(liveSources(states)).toEqual(["csv:accounting"]);
    expect(stoppedSources(states).map((s) => s.provider)).toEqual(["google_calendar"]);
  });

  it("**陰性**: CSV が45日を超えて古ければ止まっている源として扱う（Google だけを特別扱いしない）", () => {
    const states = sourceStates({
      connections: [],
      lastIngestedBySource: { "csv:accounting": daysAgo(CSV_STALE_DAYS + 1) },
      now: NOW,
    });
    expect(liveSources(states)).toEqual([]);
    expect(states[0]).toMatchObject({ provider: "csv:accounting", status: "stale" });
  });

  it("ちょうど45日は生きている（境界で止めすぎない）", () => {
    const states = sourceStates({
      connections: [],
      lastIngestedBySource: { "csv:accounting": daysAgo(CSV_STALE_DAYS) },
      now: NOW,
    });
    expect(liveSources(states)).toEqual(["csv:accounting"]);
  });

  it("**陰性**: 持っていない源は返さない（無い源を「止まっている」と書かない）", () => {
    const states = sourceStates({ connections: [], lastIngestedBySource: {}, now: NOW });
    expect(states).toEqual([]);
  });

  it("連携が1つでも active なら生きている", () => {
    const states = sourceStates({
      connections: [
        { provider: "google_calendar", status: "revoked" },
        { provider: "google_calendar", status: "active" },
      ],
      lastIngestedBySource: {},
      now: NOW,
    });
    expect(canRun(states, "google_calendar")).toBe(true);
  });
});

describe("止まっている源の1行（見えているふりをしない）", () => {
  it("カレンダーが切れていれば、再連携の導線を添える", () => {
    const line = stoppedLine({
      provider: "google_calendar",
      status: "revoked",
      lastIngestedAt: "2026-09-08T03:00:00Z",
    });
    expect(line).toBe("カレンダーは 9月8日から取れていません（再連携はこちら）");
  });

  it("入出金が古ければ、取り込みの導線を添える", () => {
    const line = stoppedLine({
      provider: "csv:accounting",
      status: "stale",
      lastIngestedAt: "2026-07-20T00:00:00Z",
    });
    expect(line).toBe("入出金は 7月20日から取れていません（取り込みはこちら）");
  });

  it("**陰性**: 最後の取り込み時刻が分からなければ、日付を作らない", () => {
    const line = stoppedLine({
      provider: "google_calendar",
      status: "revoked",
      lastIngestedAt: null,
    });
    expect(line).toBe("カレンダーは 取れていません（再連携はこちら）");
    expect(line).not.toMatch(/\d+月\d+日/);
  });
});

describe("配信の判定（PS-9c の改訂）", () => {
  it("**Google が revoked でも、生きている源があれば配る**", () => {
    const plan = planCompany(
      target({
        sources: [
          { provider: "google_calendar", status: "revoked", lastIngestedAt: daysAgo(5) },
          { provider: "csv:accounting", status: "live", lastIngestedAt: daysAgo(3) },
        ],
      }),
      "daily",
      NOW,
    );

    expect(plan.action).toBe("deliver");
    expect(plan.action === "deliver" && plan.live).toEqual(["csv:accounting"]);
    expect(plan.action === "deliver" && plan.stopped?.map((s) => s.provider)).toEqual([
      "google_calendar",
    ]);
  });

  it("**陰性**: 生きている源が0なら従来どおり（7日以内に案内済みなら suppress）", () => {
    const plan = planCompany(
      target({
        sources: [{ provider: "google_calendar", status: "revoked", lastIngestedAt: daysAgo(5) }],
      }),
      "daily",
      NOW,
    );
    expect(plan.action).toBe("suppress");
  });

  it("**陰性**: 源も連携も無い会社は skipped のまま", () => {
    const plan = planCompany(
      target({ connectionState: "none", lastReconnectNoticeAt: null, sources: [] }),
      "daily",
      NOW,
    );
    expect(plan).toEqual({ action: "skip", outcome: "skipped_no_connection" });
  });

  it("**陰性**: 源の情報が渡されなければ従来の会社単位の判定（引けなかった日に配信を変えない）", () => {
    const plan = planCompany(target({ sources: undefined }), "daily", NOW);
    expect(plan.action).toBe("suppress");
  });

  it("生きている源があっても宛先が無ければ配らない", () => {
    const plan = planCompany(
      target({
        email: null,
        sources: [{ provider: "csv:accounting", status: "live", lastIngestedAt: daysAgo(1) }],
      }),
      "daily",
      NOW,
    );
    expect(plan).toEqual({ action: "skip", outcome: "skipped_no_email" });
  });
});

describe("止まっている源がある会社を LLM へ入れない（fail-closed）", () => {
  const dispatch = readFileSync(
    path.resolve(__dirname, "../../supabase/functions/_shared/dispatch.ts"),
    "utf8",
  );
  const pulse = readFileSync(
    path.resolve(__dirname, "../../supabase/functions/deliver-pulse/index.ts"),
    "utf8",
  );
  const weekly = readFileSync(
    path.resolve(__dirname, "../../supabase/functions/deliver-weekly/index.ts"),
    "utf8",
  );

  /**
   * **文字列を探すだけの試験にしない。** 最初はそう書いていて、
   * `const hasStopped = false;` に壊しても緑のままだった（2026-09-13 に実測）。
   * `runDispatch` を実際に呼び、`run-sense` が呼ばれたかを数える
   */
  async function runWith(sources: CompanyTarget["sources"]) {
    const calls: string[] = [];
    const result = await runDispatch(
      "daily",
      { kind: "internal" },
      {
        listTargets: async () => [target({ sources })],
        invoke: async (fn: string) => {
          calls.push(fn);
          return { ok: true, status: 200 };
        },
        countBillingUnresolved: async () => ({ unresolved: 0, resolved: 0, stale: 0 }),
        notifyOpsBillingUnresolved: async () => ({ ok: true as const }),
        recordDispatch: async () => ({ ok: true }),
      },
    );
    return { calls, body: result.body as { sense_skipped_stopped_source: number } };
  }

  it("(f) **陰性**: 止まっている源が1つでもあれば run-sense を呼ばない", async () => {
    const { calls, body } = await runWith([
      { provider: "google_calendar", status: "revoked", lastIngestedAt: daysAgo(5) },
      { provider: "csv:accounting", status: "live", lastIngestedAt: daysAgo(3) },
    ]);

    expect(calls).not.toContain("run-sense");
    expect(calls).toContain("state-baselines");
    expect(calls).toContain("deliver-pulse");
    expect(body.sense_skipped_stopped_source).toBe(1);
  });

  it("全部の源が生きていれば run-sense を呼ぶ（**止めすぎない**）", async () => {
    const { calls, body } = await runWith([
      { provider: "google_calendar", status: "live", lastIngestedAt: daysAgo(1) },
      { provider: "csv:accounting", status: "live", lastIngestedAt: daysAgo(3) },
    ]);

    expect(calls).toContain("run-sense");
    expect(body.sense_skipped_stopped_source).toBe(0);
  });

  it("(f) 呼ばなかった会社数を要約に出す（**0件でも必ず出す**）", () => {
    expect(dispatch).toContain("sense_skipped_stopped_source: 0");
  });

  it("(g) 毎朝の配信は、止まっている源のイベントを材料に入れない", () => {
    expect(pulse).toContain("stopped.map((st) => st.provider)");
  });

  it("(g) 週次は、カレンダーが止まっていたら会議を読まない", () => {
    expect(weekly).toContain("calendarStopped");
    expect(weekly).toMatch(/calendarStopped\s*\?\s*\[\]/);
  });

  it("(h) 止まっている源の1行を本文に足す（**黙って項目を消さない**）", () => {
    expect(pulse).toContain("stopped.map(stoppedLine)");
    expect(weekly).toContain("stopped.map(stoppedLine)");
  });
});

describe("受け手の関数が止まっている源を更新しない", () => {
  const baselines = readFileSync(
    path.resolve(__dirname, "../../supabase/functions/state-baselines/index.ts"),
    "utf8",
  );

  it("入出金の平常値は、入出金の源が生きているときだけ更新する", () => {
    expect(baselines).toContain('live.includes("csv:accounting")');
    expect(baselines).toContain("if (runCash) {");
  });

  it("予定の平常値は、カレンダーが生きているときだけ更新する", () => {
    expect(baselines).toContain('live.includes("google_calendar")');
    expect(baselines).toContain("if (runSchedule) {");
  });

  it("**陰性**: 止まっている源を空の観測で上書きしない（`[]` で upsert する形を持たない）", () => {
    // 空で upsert すると既存の平常値が消え、再連携した日に何日も判断できなくなる
    expect(baselines).not.toContain("!runCash ? [] :");
    expect(baselines).not.toContain("!runSchedule ? [] :");
  });

  it("源の情報が渡されなければ、従来どおり全部を更新する", () => {
    expect(baselines).toContain("live === null ||");
  });
});
