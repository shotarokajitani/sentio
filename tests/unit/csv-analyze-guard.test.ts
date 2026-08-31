/**
 * CH-1-2 / CH-1-3 / CH-1-4 / CH-3-3: 列名の行が無いCSVを**プロンプトに入る前に**断る
 * （契約 `docs/contracts/slice-csv-headerguard.md`・スライスCH）。
 *
 * **陰性コントロールがここの主役である。** CH-1-2 が要求しているのは
 * 「エラーになる」ではなく「**`/api/csv/analyze` を呼ばない**」であり、両者は別物である。
 * サーバ側で弾く形だけにすると、列名は**送られてから**断られる。
 * 送られてしまえば取り消せない（CH-D8: Anthropic 側のログは Sentio から消せない）。
 * したがって関門は `fetch` より手前に置き、ここではスパイ `fetch` が
 * **一度も呼ばれない**ことを直接見る（`tests/unit/disconnect-confirm.test.ts` と同じ形）。
 *
 * サーバ側（CH-1-3 / CH-1-4）は多層目である。API は直接叩けるので、同じ純関数で閉じる。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { CSV_ANALYZE_ENDPOINT, requestColumnMapping, type CsvTypeStat } from "@/lib/csv/analyze";
import { ZENGIN_FIRST_ROW, BANK_HEADER_ROW } from "../fixtures/csv-rows";

/** 呼ばれたら記録するだけの fetch。**呼ばれないこと**を見るために使う */
function spyFetch(response?: Response) {
  return vi.fn(async () => response ?? jsonResponse(200, { mapping: MAPPING }));
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const MAPPING = {
  date: "取引日",
  description: "摘要",
  amount: null,
  direction: null,
  credit: "お預り金額",
  debit: "お支払金額",
  balance: "差引残高",
};

function typeStats(headers: string[]): Record<string, CsvTypeStat> {
  return Object.fromEntries(
    headers.map((h) => [h, { type: "string", digits: null, sample_count: 1 }]),
  );
}

describe("CH-1-2 クライアント: 列名の行が無ければ API を呼ばない（陰性コントロール）", () => {
  it("全銀協フォーマット系の1行目で fetch が一度も呼ばれない", async () => {
    const fetchImpl = spyFetch();

    const result = await requestColumnMapping({
      headers: ZENGIN_FIRST_ROW,
      rowCount: 120,
      typeStats: typeStats(ZENGIN_FIRST_ROW),
      fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      reason: "no_header_row",
      verdict: { isHeader: false, total: 17, nonNameLike: 14 },
    });
  });

  it("列が1つも無いときも fetch が呼ばれない（fail-closed）", async () => {
    const fetchImpl = spyFetch();

    const result = await requestColumnMapping({
      headers: [],
      rowCount: 0,
      typeStats: {},
      fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it("陽性: 列名の行があるときだけ、既存の API を1回だけ呼ぶ（CH-3-1）", async () => {
    const fetchImpl = spyFetch();

    const result = await requestColumnMapping({
      headers: BANK_HEADER_ROW,
      rowCount: 120,
      typeStats: typeStats(BANK_HEADER_ROW),
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CSV_ANALYZE_ENDPOINT);
    expect(init.method).toBe("POST");
    // 送る形を変えない。サーバ側の受け口（headers / row_count / type_stats）はそのまま
    expect(JSON.parse(init.body as string)).toEqual({
      headers: BANK_HEADER_ROW,
      row_count: 120,
      type_stats: typeStats(BANK_HEADER_ROW),
    });
    expect(result).toEqual({ ok: true, mapping: MAPPING });
  });

  it("API が失敗したときは今までどおり失敗として持ち上げる（原因を混ぜない）", async () => {
    const fetchImpl = spyFetch(jsonResponse(500, { error: "マッピング推定に失敗しました" }));

    const result = await requestColumnMapping({
      headers: BANK_HEADER_ROW,
      rowCount: 120,
      typeStats: typeStats(BANK_HEADER_ROW),
      fetchImpl,
    });

    expect(result).toEqual({ ok: false, reason: "failed", status: 500 });
  });

  it("通信そのものに失敗したときも失敗として持ち上げる", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });

    const result = await requestColumnMapping({
      headers: BANK_HEADER_ROW,
      rowCount: 120,
      typeStats: typeStats(BANK_HEADER_ROW),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: false, reason: "failed", status: null });
  });
});

describe("サーバ: /api/csv/analyze も同じ判定で閉じる", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function post(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/csv/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("CH-1-3 列名の行が無い入力を 400 で断る。500 にしない", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "unit-test-placeholder");
    vi.stubEnv("ANTHROPIC_MODEL", "unit-test-placeholder");
    const { POST } = await import("@/app/api/csv/analyze/route");

    const res = await POST(post({ headers: ZENGIN_FIRST_ROW, row_count: 120, type_stats: {} }));

    // 400 は「呼び出し側の入力が違う」。500 は「Sentio 側が壊れている」（CH-D6）
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("no_header_row");
  });

  it("CH-1-4 応答本文に入力セルの中身を含めない。件数と割合だけ（陰性コントロール）", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "unit-test-placeholder");
    vi.stubEnv("ANTHROPIC_MODEL", "unit-test-placeholder");
    const { POST } = await import("@/app/api/csv/analyze/route");

    const res = await POST(post({ headers: ZENGIN_FIRST_ROW, row_count: 120, type_stats: {} }));
    const body = await res.json();
    const serialized = JSON.stringify(body);

    // 断った理由をエラー本文に載せると、塞いだはずの経路が本文で開く。
    // 1〜2文字のセル（`1` `0` `3`）は件数の桁と区別がつかないので、ここでは
    // **識別性のあるセル**だけを見る。本文が件数と割合しか持たないことは、
    // 直後の完全一致が固定する（そちらが「だけ」を保証する側である）
    for (const cell of ZENGIN_FIRST_ROW.filter((c) => c.length >= 3)) {
      expect(serialized).not.toContain(cell);
    }
    expect(body).toEqual({ error: "no_header_row", total: 17, non_name_like: 14, ratio: 0.82 });
  });

  it("CH-3-3 設定チェックは判定より前に残す。鍵が無ければ 500 のまま", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_MODEL", "");
    const { POST } = await import("@/app/api/csv/analyze/route");

    const res = await POST(post({ headers: ZENGIN_FIRST_ROW, row_count: 120, type_stats: {} }));

    // 鍵が無いのは Sentio 側の不備である。入力のせいにしない
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("ANTHROPIC_API_KEY");
  });

  it("列名が無い（配列が空）ときの既存の 400 を壊さない", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "unit-test-placeholder");
    vi.stubEnv("ANTHROPIC_MODEL", "unit-test-placeholder");
    const { POST } = await import("@/app/api/csv/analyze/route");

    const res = await POST(post({ headers: [], row_count: 0, type_stats: {} }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("headers required");
  });
});
