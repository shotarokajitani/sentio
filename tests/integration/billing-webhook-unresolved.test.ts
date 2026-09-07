/**
 * ④-a の実DB検証（マイグレーション `00029`）。
 *
 * **単体テストでは、逆引きも RLS も「呼んだつもり」しか見えない。**
 * webhook 側の単体テストは `rpc()` をモックしているので、
 * 関数が実在するか・service_role 以外から実行できないか・
 * 表が本当に閉じているかは、ここでしか分からない。
 *
 * 見るのは5つ。
 *   1. **`relrowsecurity` が実際に true であること。**
 *      ポリシー0本と RLS 有効は別の設定で、後者が抜けると anon から読める
 *   2. 逆引きが**当たる**（陽性）
 *   3. 0件・2件以上では会社を返さないが、**一致数は返す**
 *      （呼び出し側が not_found と ambiguous を書き分けるため）
 *   4. 逆引きも表も、anon / ログイン済みユーザーからは触れない（陰性）
 *   5. 同じイベントIDで2回入らない（冪等・受入 5-4）
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveRlsRunMode } from "../helpers/rls-run-mode";

const SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const mode = resolveRlsRunMode({
  ci: Boolean(process.env.CI),
  anonKey: ANON_KEY,
  serviceKey: SERVICE_KEY,
});

if (mode === "skip") {
  // 静かなskipにしない。何が実行されなかったかを必ず出力する
  process.stderr.write(
    "\n[billing-webhook-unresolved.test] SKIP: SUPABASE_ANON_KEY / " +
      "SUPABASE_SERVICE_ROLE_KEY が未設定のため 00029 の実DB検証は未実行（ローカル環境）。\n\n",
  );
  describe.skip("④-a 実DB検証（SUPABASE_*未設定のため未実行）", () => {
    it("未実行", () => {});
  });
}

if (mode === "fail") {
  describe("④-a 実DB検証 — 実行環境ガード", () => {
    it("CIではSUPABASE_*が注入されていること", () => {
      throw new Error(
        "CI環境で SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定。" +
          "逆引き関数とRLSの検証がskipされる状態は fail-open のため失敗として扱う。",
      );
    });
  });
}

if (mode === "run") {
  describe("④-a: 会社の逆引きと、引けなかったイベントの表（00029）", () => {
    let admin: SupabaseClient;
    let anon: SupabaseClient;

    const RUN_ID = `bwu${Date.now().toString(36)}`;
    /** 実在しない形の識別子を使う（本物の customer id を持ち込まない） */
    const CUSTOMER = `cus_test_${RUN_ID}`;
    const DUPLICATE = `cus_dup_${RUN_ID}`;
    const createdUserIds: string[] = [];

    async function makeUser(label: string, customerId: string | null): Promise<string> {
      const { data, error } = await admin.auth.admin.createUser({
        email: `${RUN_ID}-${label}@example.test`,
        password: `Bwu!${RUN_ID}${label}9x`,
        email_confirm: true,
        user_metadata: customerId
          ? {
              subscription: {
                plan_id: "standard",
                status: "active",
                stripe_customer_id: customerId,
              },
            }
          : {},
      });
      if (error || !data.user) throw new Error(`createUser(${label}) 失敗: ${error?.message}`);
      createdUserIds.push(data.user.id);
      return data.user.id;
    }

    let ownerId: string;

    beforeAll(async () => {
      admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
      anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });

      ownerId = await makeUser("owner", CUSTOMER);
      // 同じ customer id を2人が持つ状態（**あってはならないが、あったときに書かない**）
      await makeUser("dup1", DUPLICATE);
      await makeUser("dup2", DUPLICATE);
      // 購読を持たないユーザー。逆引きが空文字で当たらないことを見る
      await makeUser("plain", null);
    });

    afterAll(async () => {
      await admin
        .from("billing_webhook_unresolved")
        .delete()
        .like("stripe_event_id", `${RUN_ID}_%`);
      for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
    });

    // ---------- RLS そのもの（**ポリシー0本と RLS 有効は別の設定である**） ----------

    it("**relrowsecurity = true を実物で測る**（0本だから読めない、で済ませない）", () => {
      // PostgREST から `pg_class` は引けない（`scripts/live-schema.ts` と同じ理由）。
      // 検査のために本番のAPI表面を広げないので、psql で直接測る。
      const dbUrl = process.env.SUPABASE_DB_URL;
      if (!dbUrl) {
        // **skip にしない。** 測っていないことを緑で通すと、RLS が外れても気づかない
        throw new Error(
          "SUPABASE_DB_URL が未設定のため relrowsecurity を実測できない。" +
            "ローカルでは `supabase status -o env` の DB_URL を渡すこと",
        );
      }

      const sql =
        "SELECT c.relrowsecurity, " +
        "(SELECT count(*) FROM pg_policies WHERE schemaname = 'public' " +
        "AND tablename = 'billing_webhook_unresolved') AS policies " +
        "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE n.nspname = 'public' AND c.relname = 'billing_webhook_unresolved'";

      const out = execFileSync("psql", [dbUrl, "-A", "-t", "-F", "\t", "-c", sql], {
        encoding: "utf8",
      }).trim();

      // 行そのものを残す。**値を引用できる形でログに出す**
      process.stderr.write(`\n[00029] relrowsecurity / policies = ${out}\n`);

      const [rls, policies] = out.split("\t");
      expect(rls).toBe("t");
      expect(policies).toBe("0");
    });

    // ---------- 逆引き ----------

    it("陽性: customer id から会社を引ける", async () => {
      const { data, error } = await admin.rpc("company_id_by_stripe_customer", {
        p_customer_id: CUSTOMER,
      });

      expect(error).toBeNull();
      expect(data).toMatchObject({ company_id: ownerId, matches: 1 });
    });

    it("陰性: 一致が無ければ NULL（推測しない）", async () => {
      const { data, error } = await admin.rpc("company_id_by_stripe_customer", {
        p_customer_id: `cus_missing_${RUN_ID}`,
      });

      expect(error).toBeNull();
      // **0件であることまで返す。** 呼び出し側が not_found と ambiguous を書き分ける
      expect(data).toMatchObject({ company_id: null, matches: 0 });
    });

    it("陰性: **2人が同じ customer id を持つときは NULL**（どちらかに書かない）", async () => {
      const { data, error } = await admin.rpc("company_id_by_stripe_customer", {
        p_customer_id: DUPLICATE,
      });

      expect(error).toBeNull();
      expect(data).toMatchObject({ company_id: null, matches: 2 });
    });

    it("陰性: 空文字では引けない（購読を持たないユーザーに当たらない）", async () => {
      const { data } = await admin.rpc("company_id_by_stripe_customer", { p_customer_id: "" });
      expect(data).toMatchObject({ company_id: null, matches: 0 });
    });

    it("陰性: anon からは逆引きを実行できない（EXECUTE を剥がしてある）", async () => {
      const { error } = await anon.rpc("company_id_by_stripe_customer", {
        p_customer_id: CUSTOMER,
      });

      // **エラーが出ること自体が要件である。** 通ると customer id → 会社ID が誰でも引ける
      expect(error).not.toBeNull();
    });

    // ---------- 引けなかったイベントの表 ----------

    it("陽性: service_role は行を書ける", async () => {
      const { error } = await admin.from("billing_webhook_unresolved").insert({
        stripe_event_id: `${RUN_ID}_first`,
        event_type: "customer.subscription.updated",
        reason: "not_found",
        stripe_customer_id: CUSTOMER,
      });

      expect(error).toBeNull();
    });

    it("5-4 冪等: 同じイベントIDでは2行にならない", async () => {
      const row = {
        stripe_event_id: `${RUN_ID}_same`,
        event_type: "customer.subscription.updated",
        reason: "not_found",
        stripe_customer_id: CUSTOMER,
      };
      const opts = { onConflict: "stripe_event_id", ignoreDuplicates: true };

      expect((await admin.from("billing_webhook_unresolved").upsert(row, opts)).error).toBeNull();
      expect((await admin.from("billing_webhook_unresolved").upsert(row, opts)).error).toBeNull();

      const { count, error } = await admin
        .from("billing_webhook_unresolved")
        .select("stripe_event_id", { count: "exact", head: true })
        .eq("stripe_event_id", `${RUN_ID}_same`);

      expect(error).toBeNull();
      expect(count).toBe(1);
    });

    it("想定外の reason は CHECK で弾く（自由文字列にしない）", async () => {
      const { error } = await admin.from("billing_webhook_unresolved").insert({
        stripe_event_id: `${RUN_ID}_badreason`,
        event_type: "customer.subscription.updated",
        reason: "whatever",
        stripe_customer_id: CUSTOMER,
      });

      expect(error).not.toBeNull();
    });

    it("陰性: anon からは1行も読めない（RLS ポリシー0本＋GRANT なし）", async () => {
      const { data, error } = await anon
        .from("billing_webhook_unresolved")
        .select("stripe_event_id");

      // 権限エラーか、空か。**中身が返らないことが要件**である
      expect(error ?? data).not.toEqual([
        expect.objectContaining({ stripe_event_id: `${RUN_ID}_first` }),
      ]);
      expect(data ?? []).toEqual([]);
    });

    it("陰性: anon からは書き込めない", async () => {
      const { error } = await anon.from("billing_webhook_unresolved").insert({
        stripe_event_id: `${RUN_ID}_anon`,
        event_type: "customer.subscription.updated",
        reason: "not_found",
        stripe_customer_id: CUSTOMER,
      });

      expect(error).not.toBeNull();
    });

    it("**3日を超えた未解決**を実DBで数えられる（dispatch-daily の集計と同じ形）", async () => {
      const old = `${RUN_ID}_stale`;
      const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
      const threshold = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

      await admin.from("billing_webhook_unresolved").insert({
        stripe_event_id: old,
        event_type: "customer.subscription.updated",
        reason: "retrieve_failed",
        stripe_customer_id: CUSTOMER,
        created_at: fourDaysAgo,
      });

      const { count, error } = await admin
        .from("billing_webhook_unresolved")
        .select("stripe_event_id", { count: "exact", head: true })
        .is("resolved_at", null)
        .lt("created_at", threshold)
        .eq("stripe_event_id", old);

      expect(error).toBeNull();
      // **「再送中でまだ望みがある」と「再送が尽きた」を分けるための数え方**
      expect(count).toBe(1);
    });

    it("再送で直った行は `resolved_at` で閉じられる（webhook 側と同じ更新の形）", async () => {
      const id = `${RUN_ID}_reopened`;
      await admin.from("billing_webhook_unresolved").insert({
        stripe_event_id: id,
        event_type: "customer.subscription.updated",
        reason: "lookup_failed",
        stripe_customer_id: CUSTOMER,
      });

      const { error } = await admin
        .from("billing_webhook_unresolved")
        .update({ resolved_at: new Date().toISOString() })
        .eq("stripe_event_id", id)
        .is("resolved_at", null);

      expect(error).toBeNull();

      const { count } = await admin
        .from("billing_webhook_unresolved")
        .select("stripe_event_id", { count: "exact", head: true })
        .is("resolved_at", null)
        .eq("stripe_event_id", id);

      expect(count).toBe(0);
    });

    it("集計は resolved_at IS NULL だけを数える（対処済みは鳴らし続けない）", async () => {
      const done = `${RUN_ID}_resolved`;
      await admin.from("billing_webhook_unresolved").insert({
        stripe_event_id: done,
        event_type: "customer.subscription.deleted",
        reason: "retrieve_failed",
        stripe_customer_id: CUSTOMER,
      });
      await admin
        .from("billing_webhook_unresolved")
        .update({ resolved_at: new Date().toISOString() })
        .eq("stripe_event_id", done);

      const { count } = await admin
        .from("billing_webhook_unresolved")
        .select("stripe_event_id", { count: "exact", head: true })
        .is("resolved_at", null)
        .eq("stripe_event_id", done);

      expect(count).toBe(0);
    });
  });
}
