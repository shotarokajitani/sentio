/**
 * ログイン／登録の二度押しをクライアントで止める（2026-09-13 の本番ログ・(n)）。
 *
 * 応答に約2秒かかる間にボタンが二度押され、同じ Turnstile のトークンで2回目が届いていた。
 * DOM を起こさずに、**2回目の submit を止める判断**と、**押せない状態の描画**を見る。
 */
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LoginForm, SubmitButton, createSubmitGuard } from "@/app/login/login-form";
import { ja } from "@/i18n/ja";

describe("送信は1回だけ", () => {
  it("1回目の submit は止めない（通常の POST をそのまま送る）", () => {
    const guard = createSubmitGuard();
    const first = { preventDefault: vi.fn() };

    expect(guard(first)).toBe(true);
    expect(first.preventDefault).not.toHaveBeenCalled();
  });

  it("(n) **陰性**: 2回目以降の submit はブラウザの外に出さない", () => {
    const guard = createSubmitGuard();
    guard({ preventDefault: vi.fn() });

    for (let i = 0; i < 3; i++) {
      const again = { preventDefault: vi.fn() };
      expect(guard(again)).toBe(false);
      expect(again.preventDefault).toHaveBeenCalledTimes(1);
    }
  });

  it("フォームごとに別に数える（登録とログインが干渉しない）", () => {
    const a = createSubmitGuard();
    const b = createSubmitGuard();
    a({ preventDefault: vi.fn() });
    expect(b({ preventDefault: vi.fn() })).toBe(true);
  });
});

describe("送信中のボタン", () => {
  const render = (pending: boolean) =>
    renderToStaticMarkup(
      createElement(SubmitButton, {
        pending,
        label: "ログイン",
        pendingLabel: ja.login.submitting,
      }),
    );

  it("(n) **陰性**: 送信中は disabled で、文言は「送信中…」", () => {
    const html = render(true);
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toContain("送信中…");
    expect(html).not.toContain(">ログイン<");
  });

  it("送信前は押せて、文言はそのまま", () => {
    const html = render(false);
    expect(html).not.toMatch(/<button[^>]*disabled/);
    expect(html).toContain(">ログイン<");
  });
});

describe("intent はボタンではなく hidden で送る", () => {
  it("**陰性**: 押せなくしたボタンの値は送信から落ちるので、ボタンに name を付けない", () => {
    const html = renderToStaticMarkup(
      createElement(LoginForm, {
        intent: "signup",
        label: "新規登録",
        pendingLabel: ja.login.submitting,
      }, null),
    );

    expect(html).toContain('<input type="hidden" name="intent" value="signup"/>');
    expect(html).not.toMatch(/<button[^>]*name=/);
    expect(html).toContain('action="/api/auth/session"');
    expect(html).toContain('method="post"');
  });
});
