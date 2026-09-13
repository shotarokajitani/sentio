/**
 * カスタマーポータルを開いてよいかの判定（2026-09-13 の点検・PR-1）。
 *
 * 以前は customer id を `user_metadata` から読み、そのまま Stripe に渡していた。
 * `user_metadata` は利用者本人が書けるので、**他社の `cus_` を書くと他社のポータルが開けた。**
 *
 * 読み元を `app_metadata` に移したうえで、購読の本当の customer を Stripe から取り直し、
 * 一致しなければ開かない（二重の守り）。
 */
import { describe, it, expect, vi } from "vitest";
import { decidePortal } from "@/lib/billing/portal-guard";
import { subscriptionFromUser } from "@/lib/auth/company";

describe("ポータルを開いてよいか", () => {
  it("customer が購読と一致すれば開く", async () => {
    const out = await decidePortal(
      { customerId: "cus_own", subscriptionId: "sub_own" },
      async () => "cus_own",
    );
    expect(out).toEqual({ ok: true, customerId: "cus_own" });
  });

  it("**陰性**: customer が購読と一致しなければ 409 で開かない", async () => {
    const out = await decidePortal(
      { customerId: "cus_other_company", subscriptionId: "sub_own" },
      async () => "cus_own",
    );
    expect(out).toEqual({ ok: false, status: 409, error: "customer_mismatch" });
  });

  it("**陰性**: 購読 id が無ければ、Stripe に問い合わせる前に 404", async () => {
    const retrieve = vi.fn(async () => "cus_own");
    const out = await decidePortal({ customerId: "cus_own", subscriptionId: null }, retrieve);

    expect(out).toEqual({ ok: false, status: 404, error: "no_subscription" });
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("**陰性**: 購読が Stripe に無ければ 404（テストの値が本番に残っていた場合）", async () => {
    const out = await decidePortal(
      { customerId: "cus_own", subscriptionId: "sub_test_only" },
      async () => {
        throw new Error("No such subscription");
      },
    );
    expect(out).toEqual({ ok: false, status: 404, error: "subscription_not_found" });
  });
});

describe("購読の読み方は app_metadata だけを見る", () => {
  it("app_metadata の購読を読む", () => {
    const sub = subscriptionFromUser({
      app_metadata: {
        subscription: {
          status: "active",
          stripe_customer_id: "cus_1",
          stripe_subscription_id: "sub_1",
        },
      },
    });
    expect(sub).toEqual({ status: "active", customerId: "cus_1", subscriptionId: "sub_1" });
  });

  it("**陰性**: user_metadata にだけ購読があっても読まない（利用者が書ける場所）", () => {
    const user = {
      app_metadata: { provider: "email" },
      user_metadata: {
        subscription: {
          status: "active",
          stripe_customer_id: "cus_other",
          stripe_subscription_id: "sub_other",
        },
      },
    };
    expect(subscriptionFromUser(user)).toEqual({
      status: null,
      customerId: null,
      subscriptionId: null,
    });
  });
});
