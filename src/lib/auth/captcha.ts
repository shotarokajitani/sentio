/**
 * 登録とログインの CAPTCHA（2026-09-13 の点検・13b）。
 *
 * **確かめるのは Supabase Auth である**（Attack Protection の Turnstile）。
 * こちらはトークンを受け取って `signUp` / `signInWithPassword` の `options.captchaToken` に
 * 渡すだけで、Cloudflare に問い合わせない。シークレットは Supabase のダッシュボードにだけ置く。
 *
 * ## 有効にする順序
 *
 * Supabase で CAPTCHA を有効にすると、**トークンの無い登録とログインは拒否される。**
 * このコードが本番に出る前に有効にすると、既存の利用者が全員ログインできなくなる。
 * **サイトキーを Vercel に入れて配り直し、画面にウィジェットが出たのを見てから有効にする。**
 */

/** Turnstile のウィジェットがフォームに足す欄の名前（Cloudflare の既定） */
export const TURNSTILE_FIELD = "cf-turnstile-response";

export const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js";

/**
 * 画面に出すサイトキー。**未設定なら null**（ウィジェットを出さない）。
 *
 * サイトキーは公開してよい値である（ブラウザに渡る）。シークレットは別で、
 * `NEXT_PUBLIC_` に置かない。
 */
export function turnstileSiteKey(raw: string | undefined): string | null {
  const key = raw?.trim();
  return key ? key : null;
}

/** フォームからトークンを取る。**空なら undefined**（送らない） */
export function captchaTokenFrom(form: FormData): string | undefined {
  return String(form.get(TURNSTILE_FIELD) ?? "").trim() || undefined;
}

/**
 * `signUp` の `options`。自社サイトの URL と CAPTCHA のトークンを**両方とも落とさずに**載せる。
 *
 * 片方だけ書く形にすると、もう片方が上書きで消える（`options` は1つのオブジェクト）。
 */
export function signUpOptions(
  siteUrl: string,
  captchaToken: string | undefined,
): { data?: { site_url: string }; captchaToken?: string } {
  return {
    ...(siteUrl ? { data: { site_url: siteUrl } } : {}),
    ...(captchaToken ? { captchaToken } : {}),
  };
}

/** `signInWithPassword` の `options` */
export function signInOptions(captchaToken: string | undefined): { captchaToken?: string } {
  return captchaToken ? { captchaToken } : {};
}
