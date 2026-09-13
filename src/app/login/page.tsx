import Script from "next/script";
import { Masthead } from "@/components/Masthead";
import { t, errorMessage } from "@/i18n";
import { loginMode, loginView } from "@/lib/auth/login-view";
import { TURNSTILE_SCRIPT, turnstileSiteKey } from "@/lib/auth/captcha";
import { LoginForm } from "./login-form";

type Search = Promise<Record<string, string | string[] | undefined>>;

/**
 * タブに出る題も入口ごとに変える。
 * **静的な `metadata` では出し分けられない**（`?mode=` を読めない）ので
 * `generateMetadata` にする。登録の画面のタブに「ログイン」と出るのは、
 * 見出しとボタンを分けた意味を半分に減らす。
 */
export async function generateMetadata({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const signup = loginMode(first(params.mode)) === "signup";
  return { title: `${signup ? t.login.signUpTitle : t.login.title} — ${t.brand}` };
}

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * 入口は2つあるが、**1画面に主操作は1つ**である（2026-09-08）。
 *
 * 以前は「ログイン」と「新規登録」が同じ高さに並び、押し分けの根拠が下の説明文しか無かった。
 * **既存の人が誤って新規登録を押すと、エラーで初めて分かる。**
 * `?mode=signup` で入口を分け、それぞれの画面ではボタンを1つだけ置く。
 * もう一方へはテキストリンクで行き来する（**`next` は必ず引き継ぐ**）。
 *
 * **状態は URL のクエリで持つ。** 既に `?e=` と `?confirm=1` がそうなっているので体系が揃う。
 */
export default async function LoginPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const failure = errorMessage(first(params.e));
  const confirmSent = first(params.confirm) === "1";
  const next = first(params.next) ?? "/connect";
  const view = loginView(first(params.mode), next);
  const signup = view.mode === "signup";
  const siteKey = turnstileSiteKey(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);

  return (
    <main className="page">
      <Masthead />

      <h1>{signup ? t.login.signUpTitle : t.login.title}</h1>
      {/* **リードは登録のときだけ。** 「メールアドレスとパスワードだけで始められます」は
          これから始める人に向けた文で、**ログインしに来た人には要らない**。
          代わりの文を置かないのは、題と欄で用が足りているからである */}
      {signup && <p className="lead">{t.login.signUpLead2}</p>}

      {failure && (
        <div className="failure" role="alert" style={{ marginTop: 24 }}>
          <p className="failure-title">{failure}</p>
        </div>
      )}

      {confirmSent && (
        <div className="notice" style={{ marginTop: 24 }}>
          {t.login.confirmSent}
        </div>
      )}

      {/* **送信は1回だけ**（2026-09-13 の二度押し）。送信後はボタンを押せなくし「送信中…」にする。
          `intent` はボタンではなく hidden で送る（押せなくしたボタンの値は送信から落ちる） */}
      <LoginForm
        intent={view.intent}
        label={signup ? t.login.signUp : t.login.submit}
        pendingLabel={t.login.submitting}
        after={
          <p className="field-hint" style={{ marginTop: 16 }}>
            <a href={view.switchHref}>{signup ? t.login.toLogin : t.login.toSignup}</a>
          </p>
        }
      >
        <input type="hidden" name="next" value={next} />

        <label className="field">
          <span className="field-label">{t.login.email}</span>
          <input className="field-input" type="email" name="email" autoComplete="email" required />
        </label>

        <label className="field">
          <span className="field-label">{t.login.password}</span>
          <input
            className="field-input"
            type="password"
            name="password"
            autoComplete={view.passwordAutoComplete}
            minLength={8}
            required
          />
          <span className="field-hint">{t.login.passwordHint}</span>
        </label>

        {/* **登録のときだけ意味がある任意項目。** ログインでは読まれない
            （`api/auth/session/route.ts` の `site_url` は signup の枝の中にある）ので、
            ログインの画面には出さない。**聞くのはこの1つだけ**——
            自社サイトが分かると Day0 の「外から見た自社」と競合の推定が動く。
            会社名も業種も聞かない（URL から推定する） */}
        {view.showSiteUrl && (
          <label className="field">
            <span className="field-label">{t.login.siteUrl}</span>
            <input
              className="field-input"
              type="url"
              name="site_url"
              autoComplete="url"
              placeholder="https://example.co.jp"
            />
            <span className="field-hint">{t.login.siteUrlHint}</span>
          </label>
        )}

        {/* **CAPTCHA（2026-09-13 の点検・13b）。** ウィジェットが `cf-turnstile-response` を
            フォームに足し、`api/auth/session` が Supabase Auth に渡す。
            サイトキーが未設定の環境では出さない（Supabase 側で有効にしていなければ要求されない） */}
        {siteKey && (
          <div className="cf-turnstile" data-sitekey={siteKey} style={{ marginTop: 16 }} />
        )}

        {/* **主操作は1つ。** もう一方はボタンではなくリンクで置く（ボタンは LoginForm が置く） */}
      </LoginForm>

      {/* **同意の文はログイン側に出さない。** ログインするだけの人は、
          いま同意を求められていない。規約とポリシーへのリンクは両方に残す */}
      <p className="footnote">
        {view.showLegalNote && <>{t.login.legalLead} </>}
        <a href="/terms">{t.login.terms}</a> ・ <a href="/privacy">{t.login.privacy}</a>
      </p>

      {siteKey && <Script src={TURNSTILE_SCRIPT} strategy="afterInteractive" />}
    </main>
  );
}
