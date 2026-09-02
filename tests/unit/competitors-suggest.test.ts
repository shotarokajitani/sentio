/**
 * 競合の推定を起こす条件（2026-09-02）。
 *
 * **陰性コントロールが主役である。** 自社サイトのURLは**任意項目**なので、
 * 空欄のまま使い続ける利用者がいる。そのたびに 400 を叩きに行く理由が無い。
 *
 * この経路が必要になった理由自体が「呼ばれない実装が残っていた」ことなので
 * （`type: "competitor"` の entity を書くのはこのエンドポイントだけで、
 * 呼び出し元が1つも無く、**Day0 の競合の節が一度も埋まっていなかった**）、
 * **叩く条件と叩かない条件の両方**をここで固定する。
 */
import { describe, it, expect, vi } from "vitest";
import {
  COMPETITORS_SUGGEST_ENDPOINT,
  requestCompetitorSuggestion,
} from "@/lib/competitors/suggest";

function spyFetch(response?: Response) {
  return vi.fn(async () => response ?? jsonResponse(200, { count: 3 }));
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("URL が無ければネットワークに出ない（陰性コントロール）", () => {
  it("null のとき fetch が一度も呼ばれない", async () => {
    const fetchImpl = spyFetch();
    const result = await requestCompetitorSuggestion({ siteUrl: null, fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: "no_site_url" });
  });

  it("空文字・空白だけのときも呼ばれない", async () => {
    for (const siteUrl of ["", "   ", "\t"]) {
      const fetchImpl = spyFetch();
      await requestCompetitorSuggestion({ siteUrl, fetchImpl });
      expect(fetchImpl, JSON.stringify(siteUrl)).not.toHaveBeenCalled();
    }
  });
});

describe("URL があるときだけ叩く", () => {
  it("陽性: 1回だけ呼び、URL だけを送る（会社名も業種も送らない）", async () => {
    const fetchImpl = spyFetch();
    const result = await requestCompetitorSuggestion({
      siteUrl: "https://example.co.jp",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(COMPETITORS_SUGGEST_ENDPOINT);
    expect(init.method).toBe("POST");
    // **登録時に聞いているのは URL 1項目だけ**である
    expect(JSON.parse(init.body as string)).toEqual({ url: "https://example.co.jp" });
    expect(result).toEqual({ ok: true, created: 3 });
  });

  it("前後の空白は落として送る", async () => {
    const fetchImpl = spyFetch();
    await requestCompetitorSuggestion({ siteUrl: "  https://example.co.jp  ", fetchImpl });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ url: "https://example.co.jp" });
  });

  it("既に競合があるときは already として持ち上げる（サーバ側の冪等）", async () => {
    const fetchImpl = spyFetch(jsonResponse(200, { status: "already", count: 4 }));
    const result = await requestCompetitorSuggestion({ siteUrl: "https://x.jp", fetchImpl });

    expect(result).toEqual({ ok: true, created: 0, already: true });
  });

  it("失敗は失敗として持ち上げる。成功に丸めない", async () => {
    const fetchImpl = spyFetch(jsonResponse(500, { error: "x" }));
    expect(await requestCompetitorSuggestion({ siteUrl: "https://x.jp", fetchImpl })).toEqual({
      ok: false,
      reason: "failed",
      status: 500,
    });
  });

  it("通信そのものに失敗したときも失敗として持ち上げる", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    expect(
      await requestCompetitorSuggestion({
        siteUrl: "https://x.jp",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).toEqual({ ok: false, reason: "failed", status: null });
  });

  it("本文が読めなくても、成功なら 0件として扱う（消えたことにしない）", async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("not json");
          },
        }) as unknown as Response,
    );
    expect(
      await requestCompetitorSuggestion({
        siteUrl: "https://x.jp",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).toEqual({ ok: true, created: 0 });
  });
});
