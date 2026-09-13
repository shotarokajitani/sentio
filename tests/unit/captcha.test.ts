/**
 * 登録とログインに CAPTCHA のトークンを渡す（2026-09-13 の点検・13b）。
 *
 * 確かめるのは Supabase Auth で、こちらはトークンを `options.captchaToken` に載せるだけ。
 * **載せ忘れると、Supabase で有効にした瞬間に全員がログインできなくなる。**
 */
import { describe, it, expect } from "vitest";
import {
  captchaTokenFrom,
  signInOptions,
  signUpOptions,
  turnstileSiteKey,
  TURNSTILE_FIELD,
} from "@/lib/auth/captcha";

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

describe("フォームからトークンを取る", () => {
  it("Turnstile の欄の名前は cf-turnstile-response", () => {
    expect(TURNSTILE_FIELD).toBe("cf-turnstile-response");
  });

  it("トークンがあれば取る", () => {
    expect(captchaTokenFrom(form({ "cf-turnstile-response": "tok-1" }))).toBe("tok-1");
  });

  it("無い・空白だけなら undefined（空文字を Supabase に送らない）", () => {
    expect(captchaTokenFrom(form({}))).toBeUndefined();
    expect(captchaTokenFrom(form({ "cf-turnstile-response": "  " }))).toBeUndefined();
  });
});

describe("signUp に渡す options", () => {
  it("**陰性**: トークンがあれば captchaToken に載る（載らなければ有効化後に登録が全部拒否される）", () => {
    expect(signUpOptions("", "tok-1")).toEqual({ captchaToken: "tok-1" });
  });

  it("**陰性**: 自社サイトの URL とトークンの両方を落とさない", () => {
    expect(signUpOptions("https://example.co.jp", "tok-1")).toEqual({
      data: { site_url: "https://example.co.jp" },
      captchaToken: "tok-1",
    });
  });

  it("どちらも無ければ空", () => {
    expect(signUpOptions("", undefined)).toEqual({});
  });
});

describe("signInWithPassword に渡す options", () => {
  it("**陰性**: トークンがあれば captchaToken に載る", () => {
    expect(signInOptions("tok-2")).toEqual({ captchaToken: "tok-2" });
  });

  it("無ければ空", () => {
    expect(signInOptions(undefined)).toEqual({});
  });
});

describe("サイトキー", () => {
  it("設定されていれば出す", () => {
    expect(turnstileSiteKey(" 0x4AAA ")).toBe("0x4AAA");
  });

  it("未設定・空ならウィジェットを出さない", () => {
    expect(turnstileSiteKey(undefined)).toBeNull();
    expect(turnstileSiteKey("")).toBeNull();
  });
});
