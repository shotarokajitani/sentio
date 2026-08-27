/**
 * D-1 系: 画面からの解除の二段確認（契約 docs/contracts/slice-disconnect.md）
 *
 * **陰性コントロールがここの主役である。** 受入基準 D-1-2 が要求しているのは
 * 「解除が実行されない」ではなく「**API が呼ばれない**」であり、両者は別物である。
 * 確認欄を通してから API 側で弾く形にすると、確認欄の実装が壊れた日に
 * 削除がそのまま走る。したがって照合はネットワークより手前に置き、
 * ここではスパイ `fetch` が**一度も呼ばれない**ことを直接見る。
 *
 * U-2 の確定（2026-08-27）: 入力させるのはアカウントのメールアドレス。
 * 会社名を採らなかったのは、照合すべき会社名の正本が DB に存在しないため
 * （契約末尾の「U-2 の確定内容」に実測の出典を記載）。
 */
import { describe, it, expect, vi } from "vitest";
import {
  DISCONNECT_ENDPOINT,
  confirmationMatches,
  normalizeConfirmation,
  requestDisconnect,
} from "@/lib/connections/disconnect";

const EMAIL = "Owner@Example.com";

/** 呼ばれたら記録するだけの fetch。**呼ばれないこと**を見るために使う */
function spyFetch(response?: Response) {
  return vi.fn(async () => response ?? jsonResponse(200, { ok: true, eventsDeleted: 0 }));
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("normalizeConfirmation", () => {
  it("前後の空白を落とし、大文字小文字を無視する形に揃える", () => {
    expect(normalizeConfirmation("  Owner@Example.com  ")).toBe("owner@example.com");
    expect(normalizeConfirmation("\tOWNER@EXAMPLE.COM\n")).toBe("owner@example.com");
  });

  it("中間の空白は落とさない。別のアドレスを同一視しない", () => {
    expect(normalizeConfirmation("a b@example.com")).toBe("a b@example.com");
  });
});

describe("confirmationMatches", () => {
  it("陽性: 完全一致で通る", () => {
    expect(confirmationMatches(EMAIL, EMAIL)).toBe(true);
  });

  it("陽性: 前後の空白と大文字小文字の違いは通す（U-2 の確定どおり）", () => {
    expect(confirmationMatches("  owner@example.com ", EMAIL)).toBe(true);
    expect(confirmationMatches("OWNER@EXAMPLE.COM", EMAIL)).toBe(true);
  });

  it("陰性: 空欄は通さない", () => {
    expect(confirmationMatches("", EMAIL)).toBe(false);
    expect(confirmationMatches("   ", EMAIL)).toBe(false);
  });

  it("陰性: 部分一致・前方一致は通さない", () => {
    // 惜しい入力はリテラルで書かずに正本から作る。到達しうるアドレスを
    // フィクスチャに置かないため（契約 S-2-10 のガードが tests/ 全体を見ている）
    expect(confirmationMatches(EMAIL.split("@")[0], EMAIL)).toBe(false);
    expect(confirmationMatches(EMAIL.slice(0, -1), EMAIL)).toBe(false);
    expect(confirmationMatches(`${EMAIL}x`, EMAIL)).toBe(false);
  });

  it("陰性: 別のアドレスは通さない", () => {
    expect(confirmationMatches("other@example.com", EMAIL)).toBe(false);
  });

  it("陰性: 照合すべき正本が無いときは何を打っても通さない（fail-closed）", () => {
    // セッションからメールアドレスを取れなかった場合。「正本が無い＝素通し」に
    // 丸めると、二段確認が形だけ残って中身が消える
    expect(confirmationMatches("", null)).toBe(false);
    expect(confirmationMatches("anything", null)).toBe(false);
    expect(confirmationMatches("", "")).toBe(false);
    expect(confirmationMatches("   ", "  ")).toBe(false);
  });
});

describe("requestDisconnect — 照合に通らない限り API を呼ばない（D-1-2）", () => {
  it("陰性: 確認欄が空のままの送信で fetch が一度も呼ばれない", async () => {
    const fetchImpl = spyFetch();

    const result = await requestDisconnect({
      provider: "google_calendar",
      typed: "",
      accountEmail: EMAIL,
      fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: "confirmation_mismatch" });
  });

  it("陰性: 空白だけの入力でも fetch が呼ばれない", async () => {
    const fetchImpl = spyFetch();

    await requestDisconnect({
      provider: "google_calendar",
      typed: "    ",
      accountEmail: EMAIL,
      fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("陰性: 別のアドレスを入力しても fetch が呼ばれない", async () => {
    const fetchImpl = spyFetch();

    await requestDisconnect({
      provider: "google_calendar",
      typed: "other@example.com",
      accountEmail: EMAIL,
      fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("陰性: 正本が取れていないときは正しい値を打っても fetch が呼ばれない", async () => {
    const fetchImpl = spyFetch();

    const result = await requestDisconnect({
      provider: "google_calendar",
      typed: EMAIL,
      accountEmail: null,
      fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: "confirmation_mismatch" });
  });

  it("陽性: 一致したときだけ既存の disconnect API を1回だけ呼ぶ", async () => {
    const fetchImpl = spyFetch(jsonResponse(200, { ok: true, eventsDeleted: 12 }));

    const result = await requestDisconnect({
      provider: "google_calendar",
      typed: "  OWNER@example.com ",
      accountEmail: EMAIL,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(DISCONNECT_ENDPOINT);
    expect(init.method).toBe("POST");
    // 送るのは provider だけ。company_id を本文で受け取る経路を作らない
    expect(JSON.parse(init.body as string)).toEqual({ provider: "google_calendar" });
    expect(result).toEqual({ ok: true, eventsDeleted: 12 });
  });
});

describe("requestDisconnect — API の応答の扱い", () => {
  it("D-1-5: 409 deletion_blocked は成功にしない。件数をそのまま持ち上げる", async () => {
    const fetchImpl = spyFetch(
      jsonResponse(409, { error: "deletion_blocked", reason: "over-limit", count: 200000 }),
    );

    const result = await requestDisconnect({
      provider: "google_calendar",
      typed: EMAIL,
      accountEmail: EMAIL,
      fetchImpl,
    });

    expect(result).toEqual({ ok: false, reason: "deletion_blocked", count: 200000 });
  });

  it("D-1-5: count が無い 409 でも成功にしない（count は null のまま持ち上げる）", async () => {
    const fetchImpl = spyFetch(jsonResponse(409, { error: "deletion_blocked" }));

    const result = await requestDisconnect({
      provider: "google_calendar",
      typed: EMAIL,
      accountEmail: EMAIL,
      fetchImpl,
    });

    expect(result).toEqual({ ok: false, reason: "deletion_blocked", count: null });
  });

  it("500 は失敗として持ち上げる。消えたことにしない", async () => {
    const fetchImpl = spyFetch(jsonResponse(500, { error: "events_delete_failed" }));

    const result = await requestDisconnect({
      provider: "google_calendar",
      typed: EMAIL,
      accountEmail: EMAIL,
      fetchImpl,
    });

    expect(result).toEqual({ ok: false, reason: "failed", status: 500 });
  });

  it("通信断も失敗として持ち上げる。status は null", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });

    const result = await requestDisconnect({
      provider: "google_calendar",
      typed: EMAIL,
      accountEmail: EMAIL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: false, reason: "failed", status: null });
  });

  it("200 でも本文が読めなければ成功にしない", async () => {
    const fetchImpl = spyFetch({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);

    const result = await requestDisconnect({
      provider: "google_calendar",
      typed: EMAIL,
      accountEmail: EMAIL,
      fetchImpl,
    });

    expect(result).toEqual({ ok: false, reason: "failed", status: 200 });
  });

  it("200 だが eventsDeleted が数でなければ成功にしない", async () => {
    const fetchImpl = spyFetch(jsonResponse(200, { ok: true }));

    const result = await requestDisconnect({
      provider: "google_calendar",
      typed: EMAIL,
      accountEmail: EMAIL,
      fetchImpl,
    });

    expect(result).toEqual({ ok: false, reason: "failed", status: 200 });
  });
});
