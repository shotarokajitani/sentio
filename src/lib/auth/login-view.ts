/**
 * ログイン画面の「いまどちらの入口か」を決める（`/login`・2026-09-08 発注）。
 *
 * **状態は URL のクエリで持つ。** この画面は既に `?e=`（失敗）と `?confirm=1`（確認メール）を
 * URL で持っているので、`?mode=signup` を足せば体系が揃う。
 * **クライアント状態を新しく持たない**（Server Component のままでいける）。
 *
 * 置いた原則は連携カードと同じで、**1画面に主操作は1つ**である。
 * 以前は「ログイン」と「新規登録」が同じ高さに並び、押し分けの根拠が
 * 下の説明文1行しか無かった。**既存の人が誤って新規登録を押すと、エラーで初めて分かる。**
 */

export type LoginMode = "login" | "signup";

export interface LoginView {
  mode: LoginMode;
  /** 送信ボタンの `intent`。**1画面に1つだけ置く** */
  intent: LoginMode;
  /** 自社サイトのURL 欄を出すか。**登録のときだけ意味がある**（ログインでは読まれない） */
  showSiteUrl: boolean;
  /** 使い回しのパスワードを勧めない。ブラウザに正しく伝える */
  passwordAutoComplete: "current-password" | "new-password";
  /** もう一方の入口へのリンク。**`next` を必ず引き継ぐ** */
  switchHref: string;
}

/**
 * `?mode=` を読む。**知らない値は `login` に倒す**（既定は既存の利用者の側）。
 */
export function loginMode(raw: string | null | undefined): LoginMode {
  return raw === "signup" ? "signup" : "login";
}

/**
 * 画面の組み立てに必要なものを1箇所で決める。
 *
 * **`next` はどちらの入口でも失われない。** 切り替えのリンクにも載せる——
 * 落とすと、連携の途中で登録に回った人が `/connect` に戻れなくなる。
 */
export function loginView(rawMode: string | null | undefined, next: string): LoginView {
  const mode = loginMode(rawMode);
  const nextParam = `next=${encodeURIComponent(next)}`;

  if (mode === "signup") {
    return {
      mode,
      intent: "signup",
      showSiteUrl: true,
      passwordAutoComplete: "new-password",
      switchHref: `/login?${nextParam}`,
    };
  }

  return {
    mode,
    intent: "login",
    showSiteUrl: false,
    passwordAutoComplete: "current-password",
    switchHref: `/login?mode=signup&${nextParam}`,
  };
}
