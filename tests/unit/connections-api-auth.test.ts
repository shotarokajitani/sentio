import { describe, it, expect, beforeAll, vi } from "vitest";

// next/headers は Next.js のリクエストコンテキストを要求するため、
// 「cookieが1つも無い＝未認証」の状態を作るために入れ物だけスタブする。
// セッション解決そのものは supabase-js の実装を通す。
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [] as { name: string; value: string }[],
    set: () => {},
  }),
}));

/**
 * A-2-1 / A-2-2 の未認証ガードはネットワークを必要としない。
 * セッションが無ければ supabase-js は通信せずに user=null を返すため、
 * Supabase を起動できない環境（Docker不可）でも実行できる。
 * 越境そのものの検証は tests/integration/connections-api.test.ts が担う。
 */
describe("A-2: /api/connections の未認証ガード", () => {
  beforeAll(() => {
    // 通信は発生しないため、クライアント生成を通すためだけのダミー値
    process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
    process.env.SUPABASE_ANON_KEY ||= "unit-test-placeholder";
  });

  it("A-2-1 セッションが無ければ 401 を返す", async () => {
    const { GET } = await import("@/app/api/connections/route");
    const res = await GET();

    expect(res.status).toBe(401);
  });

  it("A-2-2 ハンドラがリクエストを受け取らない＝company_idを外から読む経路が無い", async () => {
    const { GET } = await import("@/app/api/connections/route");

    expect(GET.length).toBe(0);
  });
});
