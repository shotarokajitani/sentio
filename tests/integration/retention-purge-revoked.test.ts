/**
 * D-3 の実DB検証（契約D「30日経過後の削除」・マイグレーション `00030` / `00031`）。
 *
 * **消しすぎは取り返しがつかない。** したがってここで見るのは、消えることより先に
 * **消えないこと**である。
 *
 *   1. 30日**未満**の取り消しは1行も対象にならない（D-3-1・陰性コントロール）
 *   2. `revoked_at` が NULL の連携は構造的に対象外（繋がっている会社を消さない）
 *   3. 30日**以上**なら、その provider 由来の行だけが対象になる（D-3-2・陽性）
 *   4. **他 provider・他社の行は巻き込まれない**（陰性コントロール）
 *   5. 実行の記録（`retention_purge_runs`）が service_role 以外から見えない
 *
 * 抽出条件そのもの（`revoked_at < cutoff`）を実DBのクエリで確かめる。
 * Edge Function 本体の実行は CI では叩かない（cron 経由・DRY-RUN が既定）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveRlsRunMode } from "../helpers/rls-run-mode";
import { REVOKED_GRACE_DAYS, revokedCutoff, sourcesForProvider } from "@/lib/retention/policy";

const SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const mode = resolveRlsRunMode({
  ci: Boolean(process.env.CI),
  anonKey: ANON_KEY,
  serviceKey: SERVICE_KEY,
});

if (mode === "skip") {
  process.stderr.write(
    "\n[retention-purge-revoked.test] SKIP: SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が" +
      "未設定のため D-3 の実DB検証は未実行（ローカル環境）。\n\n",
  );
  describe.skip("D-3 実DB検証（SUPABASE_*未設定のため未実行）", () => {
    it("未実行", () => {});
  });
}

if (mode === "fail") {
  describe("D-3 実DB検証 — 実行環境ガード", () => {
    it("CIではSUPABASE_*が注入されていること", () => {
      throw new Error(
        "CI環境で SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定。" +
          "削除の抽出条件がskipされる状態は fail-open のため失敗として扱う。",
      );
    });
  });
}

if (mode === "run") {
  describe("D-3: 取り消しから30日で消す（抽出条件と記録）", () => {
    let admin: SupabaseClient;
    let anon: SupabaseClient;

    const RUN_ID = `d3${Date.now().toString(36)}`;
    const createdUserIds: string[] = [];
    const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();

    /** 会社（＝ユーザー）を1つ作る。RLS が company_id = auth.uid() なので id がそのまま会社 */
    async function makeCompany(label: string): Promise<string> {
      const { data, error } = await admin.auth.admin.createUser({
        email: `${RUN_ID}-${label}@example.test`,
        password: `D3!${RUN_ID}${label}9x`,
        email_confirm: true,
      });
      if (error || !data.user) throw new Error(`createUser(${label}) 失敗: ${error?.message}`);
      createdUserIds.push(data.user.id);
      return data.user.id;
    }

    async function addEvent(companyId: string, source: string, label: string) {
      const { error } = await admin.from("events").insert({
        event_id: `${RUN_ID}_${label}`,
        company_id: companyId,
        occurred_at: new Date().toISOString(),
        source,
        event_type: "transaction",
        sensitivity: "S1",
      });
      if (error) throw new Error(`events insert(${label}) 失敗: ${error.message}`);
    }

    /** 取り消し済みの連携。`revoked_at` の古さだけを変える */
    async function addConnection(companyId: string, provider: string, revokedDaysAgo: number) {
      const { error } = await admin.from("connections").insert({
        company_id: companyId,
        provider,
        status: "revoked",
        revoked_at: daysAgo(revokedDaysAgo),
      });
      if (error) throw new Error(`connections insert 失敗: ${error.message}`);
    }

    let oldCompany: string;
    let freshCompany: string;
    let liveCompany: string;

    beforeAll(async () => {
      admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
      anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });

      // 31日前に取り消された会社（対象）
      oldCompany = await makeCompany("old");
      await addConnection(oldCompany, "google_calendar", 31);
      await addEvent(oldCompany, "google_calendar", "old_cal");
      // **同じ会社の別 provider 由来**。巻き込まれてはいけない
      await addEvent(oldCompany, "csv:accounting", "old_csv");

      // 29日前に取り消された会社（**まだ対象にならない**）
      freshCompany = await makeCompany("fresh");
      await addConnection(freshCompany, "google_calendar", 29);
      await addEvent(freshCompany, "google_calendar", "fresh_cal");

      // 繋がっている会社（revoked_at が NULL）
      liveCompany = await makeCompany("live");
      const { error } = await admin.from("connections").insert({
        company_id: liveCompany,
        provider: "google_calendar",
        status: "active",
      });
      if (error) throw new Error(`connections insert(live) 失敗: ${error.message}`);
      await addEvent(liveCompany, "google_calendar", "live_cal");
    });

    afterAll(async () => {
      await admin.from("events").delete().like("event_id", `${RUN_ID}_%`);
      for (const id of createdUserIds) {
        await admin.from("connections").delete().eq("company_id", id);
        await admin.from("retention_purge_runs").delete().eq("company_id", id);
        await admin.auth.admin.deleteUser(id);
      }
    });

    /** Edge Function と同じ抽出（`revoked_at < cutoff`）を実DBに投げる */
    async function targets(): Promise<string[]> {
      const cutoff = revokedCutoff(new Date()).toISOString();
      const { data, error } = await admin
        .from("connections")
        .select("company_id, provider")
        .lt("revoked_at", cutoff)
        .in("company_id", createdUserIds);

      expect(error).toBeNull();
      return (data ?? []).map((r) => r.company_id as string);
    }

    it("猶予は30日（Edge 側の写しとずれていないことは unit が固定している）", () => {
      expect(REVOKED_GRACE_DAYS).toBe(30);
    });

    it("D-3-2（陽性）: 31日前に取り消された会社は対象になる", async () => {
      expect(await targets()).toContain(oldCompany);
    });

    it("D-3-1（陰性コントロール）: 29日前は対象にならない", async () => {
      expect(await targets()).not.toContain(freshCompany);
    });

    it("陰性コントロール: `revoked_at` が NULL の連携は対象にならない", async () => {
      // **繋がっている会社を消さない。** ここが崩れると誤削除装置になる
      expect(await targets()).not.toContain(liveCompany);
    });

    it("消す範囲は provider 由来の source だけ（他は数にも入らない）", async () => {
      const sources = sourcesForProvider("google_calendar") as string[];

      const { count, error } = await admin
        .from("events")
        .select("event_id", { count: "exact", head: true })
        .eq("company_id", oldCompany)
        .in("source", sources);

      expect(error).toBeNull();
      // 同じ会社に2件入れてあるが、対象は google_calendar の1件だけ
      expect(count).toBe(1);
    });

    it("実行の記録を service_role が書ける（対象件数 / 実削除件数 / 判定）", async () => {
      const { error } = await admin.from("retention_purge_runs").insert({
        company_id: oldCompany,
        kind: "revoked_grace",
        provider: "google_calendar",
        counted: 1,
        deleted: 0,
        decision: "dry_run",
        dry_run: true,
      });

      expect(error).toBeNull();
    });

    it("**実行そのものの行**は company_id が NULL でも入る（0件でも記録が残る）", async () => {
      // これが無いと「0件だったから記録が無い」と「cron が発火していない」が同じ顔になる
      const { data, error } = await admin
        .from("retention_purge_runs")
        .insert({
          company_id: null,
          kind: "run",
          counted: 0,
          deleted: 0,
          decision: "dry_run",
          dry_run: true,
        })
        .select("id");

      expect(error).toBeNull();
      if (data?.[0]?.id) await admin.from("retention_purge_runs").delete().eq("id", data[0].id);
    });

    it("陰性コントロール: **会社ごとの行に company_id が無い**のは弾く", async () => {
      const { error } = await admin.from("retention_purge_runs").insert({
        company_id: null,
        kind: "revoked_grace",
        counted: 0,
        deleted: 0,
        decision: "dry_run",
        dry_run: true,
      });

      // NULL でよいのは kind='run' だけ。ここが緩むと、会社の分からない削除記録が残る
      expect(error).not.toBeNull();
    });

    it("想定外の decision は CHECK で弾く（自由文字列にしない）", async () => {
      const { error } = await admin.from("retention_purge_runs").insert({
        company_id: oldCompany,
        kind: "revoked_grace",
        counted: 0,
        deleted: 0,
        decision: "whatever",
        dry_run: true,
      });

      expect(error).not.toBeNull();
    });

    it("陰性コントロール: 実行の記録は anon から読めない", async () => {
      const { data } = await anon.from("retention_purge_runs").select("company_id");
      expect(data ?? []).toEqual([]);
    });
  });
}
