/**
 * W-2-2 / W-2-3: 週次レポートが**他社のものを見せない**ことと、
 * 未認証で開けないことを、実物で確かめる（契約 スライスW）。
 *
 * W-2-2 は**2社を実際に作って実クエリを投げる**以外の方法では固定できない。
 * `fetchWeeklyReport` は RLS が効くクライアントを受け取る前提の関数なので、
 * モックしたクライアントを渡しても RLS そのものを検証したことにならない。
 *
 * W-2-3 は**本物の middleware を走らせる**。`/report` を PROTECTED_PREFIXES へ
 * 足し忘れれば、この検査が落ちる。DB を要らないので実行モードの外に置く
 * （env が無くても fail-closed 側の挙動が変わらないため、常に走らせてよい）。
 *
 * **フィクスチャのメールアドレスは実在しない値にする**（契約 停止点）。
 * `.invalid` は RFC 2606 で解決されないことが保証された予約TLDである。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { resolveRlsRunMode } from "../helpers/rls-run-mode";
import { makeTenant, type Tenant } from "../helpers/tenant";
import { fetchWeeklyReport } from "@/lib/report/events";
import { jstWeekRange } from "@shared/report/weekly";

const SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const mode = resolveRlsRunMode({
  ci: Boolean(process.env.CI),
  anonKey: ANON_KEY,
  serviceKey: SERVICE_KEY,
});

describe("W-2-3: 未認証で /report を開くと /login へ飛ぶ", () => {
  async function run(pathname: string): Promise<Response> {
    const { middleware } = await import("@/middleware");
    // cookie を1つも積まない＝未認証のリクエスト
    return middleware(new NextRequest(new URL(`http://localhost${pathname}`)));
  }

  it("/report は未認証で /login へリダイレクトされる", async () => {
    const res = await run("/report");
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.pathname).toBe("/login");
  });

  it("戻り先として /report が引き継がれる", async () => {
    const res = await run("/report");
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("next")).toBe("/report");
  });

  it("陽性コントロール: 公開ページ（/privacy）は素通しされる", async () => {
    const res = await run("/privacy");
    expect(res.headers.get("location")).toBeNull();
  });
});

if (mode === "skip") {
  process.stderr.write(
    "\n[report-page.test] SKIP: SUPABASE_* が未設定のため W-2-2（越境）は未実行（ローカル環境）。" +
      "CI では env が注入され必ず実行される。\n\n",
  );
  describe.skip("W-2-2: 週次レポートの越境不可（SUPABASE_*未設定のため未実行）", () => {
    it("未実行", () => {});
  });
}

if (mode === "fail") {
  describe("W-2-2: 週次レポートの越境不可 — 実行環境ガード", () => {
    it("CIではSUPABASE_*が注入されていること", () => {
      throw new Error(
        "CI環境で SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定。" +
          "越境検証がskipされる状態は fail-open のため失敗として扱う。",
      );
    });
  });
}

if (mode === "run") {
  describe("W-2-2: 週次レポートに他社の予定が混ざらない", () => {
    let admin: SupabaseClient;
    let tenantA: Tenant;
    let tenantB: Tenant;

    const RUN_ID = `wr${Date.now().toString(36)}`;
    // 週の切り方（JST）は集計側と同じ関数から取る。テストに書き写すと、
    // 書き写したほうを検証してしまう
    const NOW = new Date();
    const WEEK = jstWeekRange(NOW);

    /** 当週の中に必ず入る時刻。月曜 00:00 JST の3時間後を使う */
    function withinWeek(offsetHours: number): { start: string; end: string } {
      const start = new Date(WEEK.start.getTime() + (3 + offsetHours) * 3_600_000);
      return {
        start: start.toISOString(),
        end: new Date(start.getTime() + 3_600_000).toISOString(),
      };
    }

    function meetingRow(companyId: string, label: string, title: string, offsetHours: number) {
      const { start, end } = withinWeek(offsetHours);
      return {
        event_id: `${RUN_ID}_${label}`,
        company_id: companyId,
        occurred_at: start,
        period_start: start,
        period_end: end,
        source: "google_calendar",
        event_type: "schedule" as const,
        entity_refs: [],
        metrics: { title, attendees: [`${label}@example.invalid`] },
        sensitivity: "S1" as const,
      };
    }

    beforeAll(async () => {
      admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
      tenantA = await makeTenant({
        admin,
        supabaseUrl: SUPABASE_URL,
        anonKey: ANON_KEY,
        runId: RUN_ID,
        label: "a",
      });
      tenantB = await makeTenant({
        admin,
        supabaseUrl: SUPABASE_URL,
        anonKey: ANON_KEY,
        runId: RUN_ID,
        label: "b",
      });

      const { error } = await admin
        .from("events")
        .insert([
          meetingRow(tenantA.id, "a1", "自社の定例", 0),
          meetingRow(tenantA.id, "a2", "自社の商談", 24),
          meetingRow(tenantB.id, "b1", "他社の予定", 0),
          meetingRow(tenantB.id, "b2", "他社の合宿", 24),
          meetingRow(tenantB.id, "b3", "他社の面談", 48),
        ]);
      if (error) throw new Error(`events 投入に失敗: ${error.message}`);
    });

    afterAll(async () => {
      await admin.from("events").delete().like("event_id", `${RUN_ID}_%`);
      for (const t of [tenantA, tenantB]) {
        if (!t) continue;
        await admin.auth.admin.deleteUser(t.id);
      }
    });

    it("自社の予定だけが件数に入る（他社の3件が混ざらない）", async () => {
      const summary = await fetchWeeklyReport(tenantA.client, tenantA.id, NOW);
      expect(summary).not.toBeNull();
      expect(summary?.meetingCount).toBe(2);
    });

    it("他社の件名が1つも出てこない", async () => {
      const summary = await fetchWeeklyReport(tenantA.client, tenantA.id, NOW);
      const serialized = JSON.stringify(summary);
      expect(serialized).not.toContain("他社の予定");
      expect(serialized).not.toContain("他社の合宿");
      expect(serialized).not.toContain("他社の面談");
      expect(serialized).toContain("自社の定例");
    });

    it("出席者のメールアドレスは実DB経由でも出力に載らない（W-2-1）", async () => {
      const summary = await fetchWeeklyReport(tenantA.client, tenantA.id, NOW);
      expect(JSON.stringify(summary)).not.toContain("example.invalid");
      // 人数だけは残る
      expect(summary?.totalAttendees).toBe(2);
    });

    it("他社側から見ても自社の予定しか見えない（対称であることを確かめる）", async () => {
      const summary = await fetchWeeklyReport(tenantB.client, tenantB.id, NOW);
      expect(summary?.meetingCount).toBe(3);
      expect(JSON.stringify(summary)).not.toContain("自社の定例");
    });
  });
}
