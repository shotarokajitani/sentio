import { Masthead } from "@/components/Masthead";
import { t, errorMessage } from "@/i18n";
import { getCompanyId } from "@/lib/auth/company";

export const metadata = { title: t.brand };

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function RegisterPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const raw = params.e;
  const failure = errorMessage(Array.isArray(raw) ? raw[0] : raw);
  const companyId = await getCompanyId();

  return (
    <main className="page">
      <Masthead signedIn={Boolean(companyId)} />

      <h1>{t.register.title}</h1>
      <p className="lead">{t.register.lead}</p>
      <p className="lead" style={{ marginTop: 0 }}>
        {t.register.lead2}
      </p>

      {failure && (
        <div className="failure" role="alert" style={{ marginTop: 24 }}>
          <p className="failure-title">{failure}</p>
        </div>
      )}

      <div className="actions" style={{ marginTop: 40 }}>
        <a className="btn" href={companyId ? "/connect" : "/login?next=%2Fconnect"}>
          {t.register.toConnect}
        </a>
      </div>

      <p className="footnote">
        <a href="/terms">{t.login.terms}</a> ・ <a href="/privacy">{t.login.privacy}</a>
      </p>
    </main>
  );
}
