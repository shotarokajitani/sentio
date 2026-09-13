/**
 * 購読の状態を利用者が書き換えられないことを、実 DB で確かめる（2026-09-13 の点検・PR-1）。
 *
 * ## 何が起きていたか
 *
 * 購読を `auth.users.user_metadata` に置いていた。**Supabase Auth の仕様で、
 * `user_metadata` は利用者本人が `auth.updateUser({ data })` で自由に書ける。**
 *
 *   - 購読していない会社が `status: "active"` を名乗り、LLM の枠を増やせた
 *   - 他社の `cus_` を書くと、他社のカスタマーポータルが開けた
 *   - 逆引きが書き換えた値で会社を引き、他社の webhook を自社に紐づけえた
 *
 * ## なぜ実 DB が要るか
 *
 * **「利用者が `user_metadata` を書けて、`app_metadata` は書けない」のは Supabase Auth の
 * 振る舞いであり、こちらのコードには現れない。** 単体試験のモックでは原理的に確かめられない。
 *
 * ## webhook の書き込み経路について
 *
 * 陽性 (c) は、webhook が購読を書くのと**同じ呼び出し**
 * （`service_role` の `auth.admin.updateUserById(id, { app_metadata })`）で入れる。
 * 署名つき webhook の全経路は Stripe の購読の取り直し（`stripe.subscriptions.retrieve`）を
 * 伴い、CI から本物の Stripe を叩けないため、**書き込みの呼び出しそのものを通す**。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { subscriptionFromUser } from "@/lib/auth/company";
import { decidePortal } from "@/lib/billing/portal-guard";

const SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const canRun = Boolean(SERVICE_KEY && ANON_KEY);

if (!canRun) {
  process.stderr.write(
    "\n[subscription-app-metadata.test] SKIP: SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定のため未実行（ローカル環境）。\n\n",
  );
}

function installDenoShim() {
  const g = globalThis as unknown as { Deno?: { env: { get(k: string): string | undefined } } };
  if (!g.Deno) g.Deno = { env: { get: (k: string) => process.env[k] } };
}

describe.skipIf(!canRun)("購読の状態を利用者が書き換えられない（実DB）", () => {
  let admin: SupabaseClient;
  const RUN = `sam${Date.now().toString(36)}`;
  const created: string[] = [];

  /** 利用者を作り、その人の JWT で動くクライアントを返す */
  async function makeUser(label: string) {
    const email = `${RUN}-${label}@example.test`;
    const password = `Sam!${RUN}${label}9x`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(`createUser(${label}) 失敗: ${error?.message}`);
    created.push(data.user.id);

    const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) throw new Error(`signIn(${label}) 失敗: ${signIn.error.message}`);
    return { id: data.user.id, client };
  }

  /** webhook が購読を書くのと**同じ呼び出し**で入れる */
  async function writeLikeWebhook(id: string, subscription: Record<string, string>) {
    const { error } = await admin.auth.admin.updateUserById(id, { app_metadata: { subscription } });
    if (error) throw new Error(`app_metadata の書き込みに失敗: ${error.message}`);
  }

  /** その利用者本人のセッションで、今の状態を読み直す */
  async function readAsUser(client: SupabaseClient) {
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) throw new Error(`getUser 失敗: ${error?.message}`);
    return data.user;
  }

  beforeAll(() => {
    installDenoShim();
    admin = createClient(SUPABASE_URL, SERVICE_KEY);
  });

  afterAll(async () => {
    if (!admin) return;
    for (const id of created) await admin.auth.admin.deleteUser(id);
  });

  it("(c) 陽性: webhook と同じ経路で書いた購読は読める", async () => {
    const u = await makeUser("positive");
    await writeLikeWebhook(u.id, {
      plan_id: "standard",
      status: "active",
      stripe_customer_id: `cus_${RUN}_own`,
      stripe_subscription_id: `sub_${RUN}_own`,
    });

    const sub = subscriptionFromUser(await readAsUser(u.client));
    expect(sub.status).toBe("active");
    expect(sub.customerId).toBe(`cus_${RUN}_own`);
  });

  it("(a) **陰性**: 利用者が user_metadata に active を書いても、購読の状態は変わらない", async () => {
    const u = await makeUser("forge");

    // **利用者本人が書ける**ことをまず確かめる（試験が効いていることの確認）
    const forged = await u.client.auth.updateUser({
      data: { subscription: { status: "active", plan_id: "standard" } },
    });
    expect(forged.error).toBeNull();

    const user = await readAsUser(u.client);
    expect(
      (user.user_metadata as { subscription?: { status?: string } }).subscription?.status,
    ).toBe("active");

    // **読み方は app_metadata だけを見るので、名乗った active は効かない**
    expect(subscriptionFromUser(user).status).toBeNull();
  });

  it("(a) **陰性**: 利用者は app_metadata を書き換えられない", async () => {
    const u = await makeUser("forge-app");
    await writeLikeWebhook(u.id, {
      plan_id: "standard",
      status: "canceled",
      stripe_customer_id: `cus_${RUN}_canceled`,
      stripe_subscription_id: `sub_${RUN}_canceled`,
    });

    // `updateUser` に app_metadata を渡しても反映されない（Supabase Auth の仕様）
    await u.client.auth.updateUser({
      data: {},
      // @ts-expect-error — 利用者の API は app_metadata を受け付けない。渡しても無視されることを見る
      app_metadata: { subscription: { status: "active" } },
    });

    expect(subscriptionFromUser(await readAsUser(u.client)).status).toBe("canceled");
  });

  it("(b) **陰性**: 他社の cus_ を user_metadata に書いても、ポータルは開かない", async () => {
    const victim = await makeUser("victim");
    await writeLikeWebhook(victim.id, {
      plan_id: "standard",
      status: "active",
      stripe_customer_id: `cus_${RUN}_victim`,
      stripe_subscription_id: `sub_${RUN}_victim`,
    });

    const attacker = await makeUser("attacker");
    await attacker.client.auth.updateUser({
      data: {
        subscription: {
          status: "active",
          stripe_customer_id: `cus_${RUN}_victim`,
          stripe_subscription_id: `sub_${RUN}_victim`,
        },
      },
    });

    const sub = subscriptionFromUser(await readAsUser(attacker.client));
    const decision = await decidePortal(
      { customerId: sub.customerId, subscriptionId: sub.subscriptionId },
      // 取り直しが呼ばれた時点で失敗にする。**呼ばれる前に止まるべき**
      async () => {
        throw new Error("購読の取り直しまで進んではいけない");
      },
    );

    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.status).toBe(404);
  });

  it("(b) **陰性**: app_metadata の customer が購読と一致しなければ 409 で開かない（二重の守り）", async () => {
    const decision = await decidePortal(
      { customerId: `cus_${RUN}_written`, subscriptionId: `sub_${RUN}_any` },
      async () => `cus_${RUN}_actual`,
    );
    expect(decision).toEqual({ ok: false, status: 409, error: "customer_mismatch" });
  });

  it("(d) **陰性**: 逆引きは user_metadata に残った古い値を拾わない", async () => {
    const u = await makeUser("legacy");
    const legacyCustomer = `cus_${RUN}_legacy`;
    // 移行前の形（user_metadata）に customer id を置く
    await admin.auth.admin.updateUserById(u.id, {
      user_metadata: { subscription: { stripe_customer_id: legacyCustomer } },
    });

    const { data, error } = await admin.rpc("company_id_by_stripe_customer", {
      p_customer_id: legacyCustomer,
    });
    expect(error).toBeNull();
    expect((data as { company_id: string | null; matches: number }).company_id).toBeNull();
    expect((data as { matches: number }).matches).toBe(0);
  });

  it("(d) 陽性: 逆引きは app_metadata の値で会社を引く", async () => {
    const u = await makeUser("lookup");
    const customer = `cus_${RUN}_lookup`;
    await writeLikeWebhook(u.id, {
      plan_id: "standard",
      status: "active",
      stripe_customer_id: customer,
      stripe_subscription_id: `sub_${RUN}_lookup`,
    });

    const { data } = await admin.rpc("company_id_by_stripe_customer", { p_customer_id: customer });
    expect((data as { company_id: string }).company_id).toBe(u.id);
  });

  it("(e) **陰性**: 配信の対象判定は app_metadata を見る（user_metadata だけ active の会社は配らない）", async () => {
    const u = await makeUser("dispatch");
    await u.client.auth.updateUser({ data: { subscription: { status: "active" } } });

    const { buildDeps } = await import("@edge/_shared/dispatch-runtime");
    const { planCompany } = await import("@edge/_shared/dispatch");

    const targets = await buildDeps("daily").listTargets();
    const t = targets.find((x) => x.companyId === u.id);
    expect(t, "対象の一覧に作った会社が居ない").toBeDefined();

    // **名乗った active は購読の状態として読まれない**
    expect(t?.subscriptionStatus).toBeNull();

    // SENTIO_ENFORCE_ENTITLEMENT=true 相当で、購読なしとして止まる
    const plan = planCompany(
      { ...t!, connectionState: "active", email: t!.email ?? "fallback@example.com" },
      "daily",
      new Date(),
      true,
    );
    expect(plan).toEqual({ action: "skip", outcome: "skipped_not_entitled" });
  });
});
