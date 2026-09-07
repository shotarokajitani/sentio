/**
 * ログイン画面の入口（`/login`・2026-09-08 発注）。
 *
 * **原則は連携カードと同じで、1画面に主操作は1つ。**
 * 以前は「ログイン」と「新規登録」が同じ高さに並び、押し分けの根拠が
 * 下の説明文1行しか無かった。**既存の人が誤って新規登録を押すと、エラーで初めて分かる。**
 *
 * ここで固定するのは3つ。
 *   1. どちらの入口でも、送信ボタンの `intent` は1つだけ
 *   2. `next` が**両方向**で失われない（切り替えのリンクにも載る）
 *   3. 知らない `?mode=` は**既存の利用者の側**（login）に倒れる
 */
import { describe, it, expect } from "vitest";
import { loginMode, loginView } from "@/lib/auth/login-view";

describe("loginMode — 知らない値は login に倒す", () => {
  it("signup のときだけ signup", () => {
    expect(loginMode("signup")).toBe("signup");
  });

  it.each([null, undefined, "", "login", "SIGNUP", "register", "1"])(
    "`%s` は login に倒れる（既定は既存の利用者の側）",
    (raw) => {
      expect(loginMode(raw)).toBe("login");
    },
  );
});

describe("原則: 1画面に主操作は1つ", () => {
  it("通常はログインだけ。**自社サイトのURL 欄も出さない**", () => {
    const view = loginView(null, "/connect");

    expect(view.mode).toBe("login");
    expect(view.intent).toBe("login");
    // ログインでは `site_url` が読まれない（route.ts の signup の枝の中にある）
    expect(view.showSiteUrl).toBe(false);
    expect(view.passwordAutoComplete).toBe("current-password");
  });

  it("?mode=signup では新規登録だけ。自社サイトのURL 欄を出す", () => {
    const view = loginView("signup", "/connect");

    expect(view.intent).toBe("signup");
    expect(view.showSiteUrl).toBe(true);
    // 使い回しのパスワードを勧めない
    expect(view.passwordAutoComplete).toBe("new-password");
  });

  it("**どちらの入口でも intent は1つだけ**（画面に2つ置けない形になっている）", () => {
    for (const mode of [null, "signup"]) {
      const view = loginView(mode, "/connect");
      expect(["login", "signup"]).toContain(view.intent);
    }
  });
});

describe("文言を入口ごとに出し分ける（2026-09-08 追加）", () => {
  it("同意の文は**登録のときだけ**出す", () => {
    // ログインするだけの人は、いま同意を求められていない
    expect(loginView("signup", "/connect").showLegalNote).toBe(true);
    expect(loginView(null, "/connect").showLegalNote).toBe(false);
  });

  it("**陰性コントロール**: 知らない mode でも同意の文は出ない（login に倒れる）", () => {
    expect(loginView("register", "/connect").showLegalNote).toBe(false);
  });
});

describe("next は両方向で引き継ぐ", () => {
  it("login → signup のリンクに next が載る", () => {
    expect(loginView(null, "/connect").switchHref).toBe("/login?mode=signup&next=%2Fconnect");
  });

  it("signup → login のリンクにも next が載る（mode は外れる）", () => {
    expect(loginView("signup", "/connect").switchHref).toBe("/login?next=%2Fconnect");
  });

  it("**陰性コントロール**: 切り替えで next が落ちない（連携の途中で登録に回っても戻れる）", () => {
    for (const mode of [null, "signup"]) {
      expect(loginView(mode, "/report").switchHref).toContain("next=%2Freport");
    }
  });

  it("クエリ付きの遷移先も壊さずに載る", () => {
    expect(loginView(null, "/connect?billing=done").switchHref).toBe(
      "/login?mode=signup&next=%2Fconnect%3Fbilling%3Ddone",
    );
  });
});
