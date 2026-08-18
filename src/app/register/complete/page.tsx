import { Masthead } from "@/components/Masthead";
import { t } from "@/i18n";

export const metadata = { title: `${t.complete.title} — ${t.brand}` };

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function CompletePage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const raw = params.events;
  const parsed = Number(Array.isArray(raw) ? raw[0] : raw);
  const events = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;

  return (
    <main className="page">
      <Masthead signedIn />

      <h1>{t.complete.title}</h1>
      <p className="lead">{t.complete.lead}</p>

      {events !== null && (
        <div className="notice" style={{ marginTop: 40 }}>
          {t.complete.syncedEvents(events)}
        </div>
      )}

      <div className="actions" style={{ marginTop: 40 }}>
        <a className="btn btn-quiet" href="/connect">
          {t.complete.backToConnect}
        </a>
      </div>
    </main>
  );
}
