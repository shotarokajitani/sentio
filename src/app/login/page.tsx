import { Masthead } from "@/components/Masthead";
import { t, errorMessage } from "@/i18n";

export const metadata = { title: `${t.login.title} — ${t.brand}` };

type Search = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export default async function LoginPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const failure = errorMessage(first(params.e));
  const confirmSent = first(params.confirm) === "1";
  const next = first(params.next) ?? "/connect";

  return (
    <main className="page">
      <Masthead />

      <h1>{t.login.title}</h1>
      <p className="lead">{t.login.lead}</p>

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

      <form method="post" action="/api/auth/session" className="section">
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
            autoComplete="current-password"
            minLength={8}
            required
          />
          <span className="field-hint">{t.login.passwordHint}</span>
        </label>

        {/* 新規登録のときだけ意味がある任意項目。**聞くのはこの1つだけ。**
            自社サイトが分かると、Day0 の「外から見た自社」と競合の推定が動く。
            入力を増やさない線引きとして、会社名も業種も聞かない（URL から推定する） */}
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

        <div className="actions">
          <button className="btn" type="submit" name="intent" value="login">
            {t.login.submit}
          </button>
          <button className="btn btn-quiet" type="submit" name="intent" value="signup">
            {t.login.signUp}
          </button>
        </div>

        <p className="field-hint" style={{ marginTop: 16 }}>
          {t.login.signUpLead}
        </p>
      </form>

      <p className="footnote">
        {t.login.legalLead} <a href="/terms">{t.login.terms}</a> ・{" "}
        <a href="/privacy">{t.login.privacy}</a>
      </p>
    </main>
  );
}
