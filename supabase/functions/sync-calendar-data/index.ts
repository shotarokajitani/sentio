import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { initSentry, captureError } from "../_shared/sentry.ts";
import { getServiceClient, corsHeaders } from "../_shared/supabase.ts";

initSentry("sync-calendar-data");

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function ensureFreshToken(integ: any) {
  if (!integ.token_expires_at) return integ;
  if (new Date(integ.token_expires_at).getTime() > Date.now() + 30_000)
    return integ;
  await fetch(`${SUPABASE_URL}/functions/v1/google-calendar-oauth/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify({ company_id: integ.company_id }),
  });
  const supa = getServiceClient();
  const { data } = await supa
    .from("integrations")
    .select("*")
    .eq("id", integ.id)
    .single();
  return data ?? integ;
}

interface CalEvent {
  id: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{
    email?: string;
    self?: boolean;
    responseStatus?: string;
  }>;
  recurringEventId?: string;
  organizer?: { email?: string; self?: boolean };
  summary?: string;
}

async function listEvents(
  token: string,
  timeMin: string,
  timeMax: string,
): Promise<CalEvent[]> {
  const events: CalEvent[] = [];
  let pageToken: string | undefined;
  // 最大 5 ページまで（safety）
  for (let i = 0; i < 5; i++) {
    const url = new URL(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    );
    url.searchParams.set("timeMin", timeMin);
    url.searchParams.set("timeMax", timeMax);
    url.searchParams.set("singleEvents", "true"); // 繰り返しを展開
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "250");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const r = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok)
      throw new Error(`calendar list failed: ${r.status} ${await r.text()}`);
    const j = await r.json();
    if (Array.isArray(j.items)) events.push(...j.items);
    pageToken = j.nextPageToken;
    if (!pageToken) break;
  }
  return events;
}

function eventStartDate(e: CalEvent): Date | null {
  const s = e.start?.dateTime ?? e.start?.date;
  if (!s) return null;
  return new Date(s);
}

function getOwnDomain(events: CalEvent[]): string | null {
  // organizer.self === true のメールからドメイン抽出
  for (const e of events) {
    if (e.organizer?.self && e.organizer.email) {
      const at = e.organizer.email.indexOf("@");
      if (at > 0) return e.organizer.email.slice(at + 1).toLowerCase();
    }
    const me = e.attendees?.find((a) => a.self && a.email);
    if (me?.email) {
      const at = me.email.indexOf("@");
      if (at > 0) return me.email.slice(at + 1).toLowerCase();
    }
  }
  return null;
}

function structureEvents(events: CalEvent[], now: Date) {
  const past30Start = new Date(now.getTime() - 30 * 86400_000);
  const future30End = new Date(now.getTime() + 30 * 86400_000);

  const ownDomain = getOwnDomain(events);

  let pastCount = 0;
  let futureCount = 0;
  let multiAttendeePast = 0;
  let multiAttendeeFuture = 0;
  let recurringCount = 0;

  // 外部ドメインごとの面談件数（過去30日）
  const externalDomainCounts: Record<string, number> = {};
  // 外部ドメインごとの面談件数（過去60-31日：比較用）
  const externalDomainCountsPrev: Record<string, number> = {};
  const past60Start = new Date(now.getTime() - 60 * 86400_000);

  for (const e of events) {
    const start = eventStartDate(e);
    if (!start) continue;

    const isPast = start < now && start >= past30Start;
    const isFuture = start >= now && start <= future30End;
    const isPrev = start < past30Start && start >= past60Start;

    const attendees = e.attendees ?? [];
    const externalAttendees = attendees.filter(
      (a) =>
        a.email &&
        !a.self &&
        (!ownDomain || !a.email.toLowerCase().endsWith("@" + ownDomain)),
    );

    if (isPast || isFuture || isPrev) {
      // 3名以上の会議
      if (attendees.length >= 3) {
        if (isPast) multiAttendeePast++;
        if (isFuture) multiAttendeeFuture++;
      }
      // 繰り返しイベント
      if (e.recurringEventId && (isPast || isFuture)) recurringCount++;

      // 外部ドメイン集計
      const seenDomains = new Set<string>();
      for (const a of externalAttendees) {
        const at = a.email!.indexOf("@");
        if (at <= 0) continue;
        const d = a.email!.slice(at + 1).toLowerCase();
        if (seenDomains.has(d)) continue;
        seenDomains.add(d);
        if (isPast)
          externalDomainCounts[d] = (externalDomainCounts[d] ?? 0) + 1;
        if (isPrev)
          externalDomainCountsPrev[d] = (externalDomainCountsPrev[d] ?? 0) + 1;
      }
    }

    if (isPast) pastCount++;
    if (isFuture) futureCount++;
  }

  // 上位10ドメインを抽出 + 前30日との差分
  const topExternalDomains = Object.entries(externalDomainCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([domain, count]) => ({
      domain,
      meetings_last_30_days: count,
      meetings_prev_30_days: externalDomainCountsPrev[domain] ?? 0,
      delta: count - (externalDomainCountsPrev[domain] ?? 0),
    }));

  return {
    own_domain: ownDomain,
    events_last_30_days: pastCount,
    events_next_30_days: futureCount,
    multi_attendee_past_30: multiAttendeePast,
    multi_attendee_next_30: multiAttendeeFuture,
    recurring_meetings: recurringCount,
    top_external_domains: topExternalDomains,
    fetched_at: now.toISOString(),
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const { company_id } = body as { company_id?: string };
    if (!company_id) return jsonResp({ error: "company_id が必要です" }, 400);

    const supa = getServiceClient();
    const { data: integ } = await supa
      .from("integrations")
      .select("*")
      .eq("company_id", company_id)
      .eq("type", "google_calendar")
      .eq("status", "connected")
      .single();

    if (!integ) {
      return jsonResp({ success: true, synced: 0, message: "未連携" });
    }

    try {
      const fresh = await ensureFreshToken(integ);

      const now = new Date();
      const timeMin = new Date(now.getTime() - 60 * 86400_000).toISOString();
      const timeMax = new Date(now.getTime() + 30 * 86400_000).toISOString();
      const events = await listEvents(fresh.access_token, timeMin, timeMax);

      const content = structureEvents(events, now);

      const expiresAt = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString();

      await supa.from("external_data").insert({
        company_id,
        source_type: "google_calendar",
        content,
        expires_at: expiresAt,
      });

      await supa
        .from("integrations")
        .update({
          last_synced_at: new Date().toISOString(),
          status: "connected",
        })
        .eq("id", integ.id);

      return jsonResp({ success: true, synced: 1, summary: content });
    } catch (e) {
      captureError(e as Error, { company_id });
      await supa
        .from("integrations")
        .update({ status: "error" })
        .eq("id", integ.id);
      return jsonResp({ success: false, error: (e as Error).message }, 500);
    }
  } catch (e) {
    captureError(e as Error);
    return jsonResp({ error: (e as Error).message }, 500);
  }
});
