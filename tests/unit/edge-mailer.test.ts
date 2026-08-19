import { describe, it, expect } from "vitest";
import { resolveMailConfig, sendEmail } from "@edge/_shared/mailer";
import { TEST_RECIPIENT } from "../fixtures/recipients";

/**
 * `slice-01` E+1 / E+3 / E+5 と契約 S-2-6。
 *
 * 過去に同じ欠陥を4関数ぶん直すことになった箇所を1本に寄せたので、
 * 規則もここ1本で固定する。
 * 1. 設定が欠けたら**送らない**（黙ってスキップして ok を返さない）
 * 2. レスポンスのステータスコードを**必ず見る**（未確認のまま ok を返さない）
 */

const env = (values: Record<string, string | undefined>) => (key: string) => values[key];

const message = {
  to: TEST_RECIPIENT,
  subject: "[Sentio] テスト",
  html: "<p>本文</p>",
  text: "本文",
};

const config = { apiKey: "re_test_key", from: "sentio@example.com" };

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response)) as unknown as typeof fetch;
}

describe("resolveMailConfig", () => {
  it("両方あれば設定を返す", () => {
    const r = resolveMailConfig(env({ RESEND_API_KEY: "re_x", RESEND_FROM: "a@example.com" }));
    expect(r).toEqual({ ok: true, config: { apiKey: "re_x", from: "a@example.com" } });
  });

  it("RESEND_API_KEY が無ければ送らない (E+5)", () => {
    const r = resolveMailConfig(env({ RESEND_FROM: "a@example.com" }));
    expect(r).toMatchObject({ ok: false, missing: ["RESEND_API_KEY"] });
  });

  it("RESEND_FROM が無ければ送らない — サンドボックスへフォールバックしない (E+3)", () => {
    const r = resolveMailConfig(env({ RESEND_API_KEY: "re_x" }));
    expect(r).toMatchObject({ ok: false, missing: ["RESEND_FROM"] });
  });

  it("空文字・空白は未設定と同じ扱い", () => {
    const r = resolveMailConfig(env({ RESEND_API_KEY: "  ", RESEND_FROM: "" }));
    expect(r).toMatchObject({ ok: false, missing: ["RESEND_API_KEY", "RESEND_FROM"] });
  });

  it("両方無ければ両方を報告する（片方だけ直して再発するのを防ぐ）", () => {
    const r = resolveMailConfig(env({}));
    expect(r).toMatchObject({ ok: false, missing: ["RESEND_API_KEY", "RESEND_FROM"] });
  });
});

describe("sendEmail", () => {
  it("2xx かつ id があれば成功で、email_id を返す", async () => {
    const r = await sendEmail(config, message, fakeFetch(200, { id: "re_abc" }));
    expect(r).toEqual({ ok: true, emailId: "re_abc" });
  });

  it("非 2xx は失敗。ステータスと理由が残る (E+1)", async () => {
    const r = await sendEmail(config, message, fakeFetch(422, { message: "domain not verified" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("422");
    expect(r.error).toContain("domain not verified");
  });

  it("2xx でも id が無ければ成功にしない", async () => {
    const r = await sendEmail(config, message, fakeFetch(200, {}));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("id が無い");
  });

  it("通信自体が失敗しても throw せず値で返す（予約行の更新経路を飛ばさない）", async () => {
    const boom = (() => Promise.reject(new Error("ECONNRESET"))) as unknown as typeof fetch;
    const r = await sendEmail(config, message, boom);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ECONNRESET");
  });

  it("宛先・差出人・本文が Resend の形で渡る", async () => {
    let sent: Record<string, unknown> = {};
    const spy = ((_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: "re_1" }),
      } as Response);
    }) as unknown as typeof fetch;

    await sendEmail(config, message, spy);

    expect(sent).toMatchObject({
      from: "sentio@example.com",
      to: [TEST_RECIPIENT],
      subject: "[Sentio] テスト",
      html: "<p>本文</p>",
      text: "本文",
    });
  });
});
