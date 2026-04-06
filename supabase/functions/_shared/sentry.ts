import * as Sentry from "https://deno.land/x/sentry/index.mjs";

const SENTRY_DSN = Deno.env.get("SENTRY_DSN");

export function initSentry(functionName: string) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: Deno.env.get("ENVIRONMENT") || "production",
    release: "sentio@1.0.0",
    integrations: [],
    tracesSampleRate: 0.1,
  });
  Sentry.setTag("function", functionName);
}

export function captureError(
  error: Error,
  context?: {
    company_id?: string;
    extra?: Record<string, unknown>;
  },
) {
  Sentry.withScope((scope) => {
    if (context?.company_id) scope.setUser({ id: context.company_id });
    if (context?.extra) scope.setExtras(context.extra);
    Sentry.captureException(error);
  });
}

export { Sentry };
