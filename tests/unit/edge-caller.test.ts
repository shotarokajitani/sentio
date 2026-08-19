import { describe, it, expect } from "vitest";
import { extractBearer, resolveCaller, resolveCompanyId } from "@edge/_shared/caller";

/**
 * S-2-9 / S-4-1 / S-4-3: Edge Function の呼び出し元判定。
 *
 * 本番実測（2026-08-19）: `state-memory-packet` は **認証情報ゼロでも、不正な Bearer でも
 * HTTP 200** を返し、`recent_events` の実データ 824文字を応答していた。
 * ここで固定するのは、その2ケースが **DBに触る前に 401 で return する** ことである。
 *
 * `verify_jwt` は署名と期限しか見ない。anon キーは公開値の正当なJWTなので、
 * 「JWTを持っているか」と「その会社の人か」は別問題である。
 */

const SERVICE_KEY = "sk-test-service-role-key-value";
const ANON_KEY = "anon-test-key-value";

function request(authHeader?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authHeader !== undefined) headers.Authorization = authHeader;
  return new Request("https://example.test/functions/v1/state-memory-packet", {
    method: "POST",
    headers,
    body: JSON.stringify({ company_id: "c-1" }),
  });
}

/** user トークンを1つだけ知っている auth スタブ。 */
const getUser = async (token: string) =>
  token === "valid-user-jwt" ? { id: "user-company-1" } : null;

const deps = { serviceRoleKey: SERVICE_KEY, getUser };

describe("extractBearer", () => {
  it("Bearer トークンを取り出す", () => {
    expect(extractBearer("Bearer abc")).toBe("abc");
  });

  it("大文字小文字を問わない", () => {
    expect(extractBearer("bearer abc")).toBe("abc");
  });

  it("ヘッダが無い・空・Bearer でない場合は null", () => {
    expect(extractBearer(null)).toBeNull();
    expect(extractBearer("")).toBeNull();
    expect(extractBearer("Basic abc")).toBeNull();
    expect(extractBearer("Bearer ")).toBeNull();
  });
});

describe("resolveCaller — 本番で開いていた2ケース", () => {
  it("Authorization ヘッダが無ければ 401（修復前は 200 だった）", async () => {
    const r = await resolveCaller(request(), ["internal"], deps);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.response.status).toBe(401);
  });

  it("不正な Bearer なら 401（修復前は 200 だった）", async () => {
    const r = await resolveCaller(request("Bearer deadbeef"), ["internal"], deps);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.response.status).toBe(401);
  });
});

describe("resolveCaller — 呼び出し元の分類", () => {
  it("service_role キーと一致すれば internal", async () => {
    const r = await resolveCaller(request(`Bearer ${SERVICE_KEY}`), ["internal"], deps);

    expect(r.ok).toBe(true);
    expect(r.ok === true && r.caller.kind).toBe("internal");
    expect(r.ok === true && r.caller.companyId).toBeNull();
  });

  it("anon キーは 401（正当なJWTでも「その会社の人」ではない）", async () => {
    const r = await resolveCaller(request(`Bearer ${ANON_KEY}`), ["internal", "user"], deps);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.response.status).toBe(401);
  });

  it("user トークンは user として解決し、company_id は JWT 由来になる", async () => {
    const r = await resolveCaller(request("Bearer valid-user-jwt"), ["internal", "user"], deps);

    expect(r.ok).toBe(true);
    expect(r.ok === true && r.caller.kind).toBe("user");
    expect(r.ok === true && r.caller.companyId).toBe("user-company-1");
  });

  it("許可されていない呼び出し元は 401（既定は internal のみ）", async () => {
    const r = await resolveCaller(request("Bearer valid-user-jwt"), ["internal"], deps);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.response.status).toBe(401);
  });

  it("service_role キーが未設定なら internal を成立させない（空文字と一致させない）", async () => {
    const r = await resolveCaller(request("Bearer "), ["internal"], {
      serviceRoleKey: "",
      getUser,
    });

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.response.status).toBe(401);
  });

  it("401 の本文に、どちらのケースで落ちたかを書かない", async () => {
    const noHeader = await resolveCaller(request(), ["internal"], deps);
    const badToken = await resolveCaller(request("Bearer deadbeef"), ["internal"], deps);

    const a = noHeader.ok === false ? await noHeader.response.text() : "";
    const b = badToken.ok === false ? await badToken.response.text() : "";

    expect(a).toBe(b);
    expect(a).not.toContain(SERVICE_KEY);
  });
});

describe("resolveCompanyId — ボディの company_id をどこまで信じるか (S-4-3)", () => {
  it("internal はボディの company_id を採用する（cron・内部呼び出し）", () => {
    const r = resolveCompanyId({ kind: "internal", companyId: null }, "c-1");
    expect(r).toEqual({ ok: true, companyId: "c-1" });
  });

  it("internal でボディに company_id が無ければ 400 相当で弾く", () => {
    const r = resolveCompanyId({ kind: "internal", companyId: null }, undefined);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.status).toBe(400);
  });

  it("user はボディを無視して JWT 由来の company_id を使う", () => {
    const r = resolveCompanyId({ kind: "user", companyId: "user-company-1" }, undefined);
    expect(r).toEqual({ ok: true, companyId: "user-company-1" });
  });

  it("user がボディで他社を指定したら 403", () => {
    const r = resolveCompanyId({ kind: "user", companyId: "user-company-1" }, "other-company");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.status).toBe(403);
  });

  it("user が自社を明示指定するのは許す", () => {
    const r = resolveCompanyId({ kind: "user", companyId: "user-company-1" }, "user-company-1");
    expect(r).toEqual({ ok: true, companyId: "user-company-1" });
  });
});
