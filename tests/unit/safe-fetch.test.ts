/**
 * SSRF 防止の共通関数（2026-09-13 の点検・PR-3 の 22）。
 *
 * `day0/index.ts` の `analyzeUrl` は、利用者が入れた URL を
 * `fetch(url, { redirect: "follow" })` でそのまま取りに行っていた。
 *
 * **DNS の解決と fetch だけを差し替える。** 判定（スキーム・IP の範囲・リダイレクトの追い方・
 * 大きさ・時間・Content-Type）は本物を通す。解決は「このホスト名はこの IP を返す」表で決める。
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SAFE_FETCH_MAX_REDIRECTS,
  isBlockedAddress,
  safeFetch,
  type SafeFetchDeps,
} from "@edge/_shared/safe-fetch";

/** ホスト名 → 解決結果の表。**表に無いホストは解決に失敗する** */
const DNS: Record<string, string[]> = {
  "www.sentio-ai.jp": ["76.76.21.21"],
  localhost: ["127.0.0.1"],
  "internal.example.com": ["10.0.0.1"],
  "redirect.example.com": ["93.184.216.34"],
  "mixed.example.com": ["93.184.216.34", "192.168.1.10"],
  "v6-internal.example.com": ["fd00:ec2::254"],
};

function html(body = "<title>Sentio</title>", init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    ...init,
  });
}

function deps(responder: (url: string) => Response | Promise<Response>): SafeFetchDeps & {
  fetch: ReturnType<typeof vi.fn>;
} {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => responder(String(input)));
  return {
    resolve: async (host: string) => {
      const found = DNS[host];
      if (!found) throw new Error(`NXDOMAIN ${host}`);
      return found;
    },
    fetch: fetchMock as unknown as typeof fetch & ReturnType<typeof vi.fn>,
  };
}

describe("発注の陰性6本: すべて拒否し、fetch に到達しない", () => {
  const cases: Array<[string, string, string]> = [
    ["http://169.254.169.254/", "blocked_address", "クラウドのメタデータ"],
    ["http://127.0.0.1/", "blocked_address", "ループバック"],
    ["http://localhost/", "blocked_address", "localhost（解決すると 127.0.0.1）"],
    ["http://internal.example.com/", "blocked_address", "DNS が 10.0.0.1 を返すホスト名"],
    ["file:///etc/passwd", "scheme_not_allowed", "file スキーム"],
  ];

  for (const [url, reason, label] of cases) {
    it(`**陰性**: ${label}（${url}）`, async () => {
      const d = deps(() => html());
      const out = await safeFetch(url, { deps: d });

      expect(out).toMatchObject({ ok: false, reason });
      expect(d.fetch).not.toHaveBeenCalled();
    });
  }

  it("**陰性**: 302 で 127.0.0.1 に飛ばす URL は、飛び先を検査して拒否する（飛び先は叩かない）", async () => {
    const d = deps((url) =>
      url.startsWith("http://redirect.example.com")
        ? new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } })
        : html(),
    );
    const out = await safeFetch("http://redirect.example.com/go", { deps: d });

    expect(out).toMatchObject({
      ok: false,
      reason: "blocked_address",
      url: "http://127.0.0.1/admin",
    });
    expect(d.fetch).toHaveBeenCalledTimes(1);
    // 自動では追わせていない
    expect(d.fetch.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });
});

describe("陽性", () => {
  it("https://www.sentio-ai.jp/ は通り、本文を読む", async () => {
    const d = deps(() => html("<title>Sentio</title>"));
    const out = await safeFetch("https://www.sentio-ai.jp/", { deps: d });

    expect(out.ok).toBe(true);
    expect(out.ok && new TextDecoder().decode(out.body!)).toBe("<title>Sentio</title>");
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it("外部から外部へのリダイレクトは3回まで追う", async () => {
    let n = 0;
    const d = deps(() => {
      n++;
      return n <= SAFE_FETCH_MAX_REDIRECTS
        ? new Response(null, { status: 301, headers: { location: `/step${n}` } })
        : html();
    });
    const out = await safeFetch("https://www.sentio-ai.jp/", { deps: d });

    expect(out).toMatchObject({ ok: true, url: "https://www.sentio-ai.jp/step3" });
    expect(d.fetch).toHaveBeenCalledTimes(4);
  });
});

describe("(a)〜(e) の残り", () => {
  it("**陰性**: 4回目のリダイレクトは追わない", async () => {
    const d = deps(() => new Response(null, { status: 302, headers: { location: "/again" } }));
    const out = await safeFetch("https://www.sentio-ai.jp/", { deps: d });

    expect(out).toMatchObject({ ok: false, reason: "too_many_redirects" });
    expect(d.fetch).toHaveBeenCalledTimes(SAFE_FETCH_MAX_REDIRECTS + 1);
  });

  it("**陰性**: 解決結果に1つでも内部の IP が混じれば拒否する", async () => {
    const d = deps(() => html());
    expect(await safeFetch("http://mixed.example.com/", { deps: d })).toMatchObject({
      ok: false,
      reason: "blocked_address",
    });
  });

  it("**陰性**: 解決できないホストは拒否する（通す側に倒さない）", async () => {
    const d = deps(() => html());
    expect(await safeFetch("http://nx.example.invalid/", { deps: d })).toMatchObject({
      ok: false,
      reason: "dns_failed",
    });
  });

  it("**陰性**: IPv6 の内部の宛先（[::1]・fd00:ec2::254 を返すホスト）も拒否する", async () => {
    const d = deps(() => html());
    expect(await safeFetch("http://[::1]/", { deps: d })).toMatchObject({
      reason: "blocked_address",
    });
    expect(await safeFetch("http://v6-internal.example.com/", { deps: d })).toMatchObject({
      reason: "blocked_address",
    });
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("**陰性**: 本文は 2MB で打ち切る", async () => {
    const big = "a".repeat(2 * 1024 * 1024 + 500);
    const d = deps(() => html(big));
    const out = await safeFetch("https://www.sentio-ai.jp/", { deps: d });

    expect(out.ok && out.body!.byteLength).toBe(2 * 1024 * 1024);
    expect(out.ok && out.truncated).toBe(true);
  });

  it("**陰性**: 時間切れ（10秒）で打ち切る", async () => {
    const d: SafeFetchDeps = {
      resolve: async () => ["76.76.21.21"],
      fetch: ((_: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as typeof fetch,
    };
    const out = await safeFetch("https://www.sentio-ai.jp/", { deps: d, timeoutMs: 50 });
    expect(out).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("**陰性**: 読んでよい種類でなければ本文を読まない（application/octet-stream）", async () => {
    const d = deps(
      () =>
        new Response("binary", {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    );
    const out = await safeFetch("https://www.sentio-ai.jp/", { deps: d });
    expect(out).toMatchObject({ ok: true, body: null });
  });

  it("text/plain・application/json・application/xml は読む", async () => {
    for (const type of ["text/plain", "application/json", "application/xml; charset=utf-8"]) {
      const d = deps(() => new Response("x", { status: 200, headers: { "content-type": type } }));
      const out = await safeFetch("https://www.sentio-ai.jp/", { deps: d });
      expect(out.ok && out.body !== null, type).toBe(true);
    }
  });
});

describe("IP の範囲", () => {
  it.each([
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "127.0.0.53",
    "169.254.169.254",
    "0.0.0.0",
    "100.64.0.1",
    "100.127.255.255",
    "::1",
    "::",
    "fc00::1",
    "fdff::1",
    "fe80::1",
    "febf::1",
    "::ffff:7f00:1",
    "::ffff:8.8.8.8",
    "fd00:ec2::254",
    "not-an-ip",
  ])("**陰性**: %s は内部として扱う", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "172.32.0.1",
    "100.128.0.1",
    "76.76.21.21",
    "2001:4860:4860::8888",
    "fec0::1",
  ])("%s は外部として通す", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe("day0 が利用者の URL を safeFetch で取りに行く", () => {
  const day0 = readFileSync(path.resolve(__dirname, "../../supabase/functions/day0/index.ts"), "utf8");

  it("analyzeUrl は safeFetch を通す", () => {
    expect(day0).toContain("const fetched = await safeFetch(url, {");
  });

  it("**陰性**: 利用者の URL を素の fetch に渡す箇所・自動でリダイレクトを追う指定が残っていない", () => {
    expect(day0).not.toContain("await fetch(url");
    expect(day0).not.toContain('redirect: "follow"');
  });
});
