import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { initSentry, captureError } from "../_shared/sentry.ts";
import { getServiceClient, corsHeaders } from "../_shared/supabase.ts";

initSentry("sync-communication-data");

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ==================== Slack ====================
// 2025年5月以降、Marketplace外アプリは conversations.history が
// Tier1（1分1リクエスト）に制限されている。直近30日で最もアクティブな
// 上位3チャンネルだけを処理し、各リクエスト間に1秒待機する。

async function slackApi(
  token: string,
  method: string,
  params: Record<string, string>,
) {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`slack ${method} failed: ${j.error}`);
  return j;
}

async function listPublicChannels(
  token: string,
): Promise<Array<{ id: string; name: string; num_members?: number }>> {
  // bot がメンバーになっているチャンネルのみ history が取れる
  const j = await slackApi(token, "conversations.list", {
    exclude_archived: "true",
    types: "public_channel",
    limit: "200",
  });
  return j.channels || [];
}

interface SlackMsg {
  ts: string;
  subtype?: string;
  user?: string;
}

async function fetchChannelHistory(
  token: string,
  channelId: string,
  oldest: number,
): Promise<SlackMsg[]> {
  // Tier1: 1分1リクエスト制限を意識して呼び出し回数を最小化
  // 1チャンネル1ページのみ取得（最大1000メッセージ）
  const j = await slackApi(token, "conversations.history", {
    channel: channelId,
    oldest: String(oldest),
    limit: "1000",
  });
  return j.messages || [];
}

function isHumanMsg(m: SlackMsg): boolean {
  // bot_message / channel_join 等を除外
  return !m.subtype && !!m.user;
}

function weeklyBuckets(messages: { ts: number }[], now: number): number[] {
  // 直近30日 → 4週分（古→新）
  const buckets = [0, 0, 0, 0];
  for (const m of messages) {
    const daysAgo = (now - m.ts) / 86400;
    if (daysAgo < 0 || daysAgo >= 30) continue;
    const idx = 3 - Math.min(3, Math.floor(daysAgo / 7));
    buckets[idx]++;
  }
  return buckets;
}

function nightRatio(messages: { ts: number }[]): number {
  let total = 0;
  let night = 0;
  for (const m of messages) {
    total++;
    // JST換算（UTC+9）
    const d = new Date(m.ts * 1000);
    const jstHour = (d.getUTCHours() + 9) % 24;
    if (jstHour >= 22 || jstHour < 6) night++;
  }
  return total === 0 ? 0 : Number((night / total).toFixed(3));
}

async function syncSlack(integ: any) {
  const token = integ.access_token;
  const now = Date.now() / 1000;
  const oldest30 = now - 30 * 86400;

  const channels = await listPublicChannels(token);

  // Tier1制限への配慮: チャンネル選定のため info ではなく
  // 直接 history を呼ぶしかないが、それでは制限に引っかかる。
  // メンバー数で簡易的にアクティブ候補を絞り、上位3つのみ history 取得。
  const candidates = channels
    .filter((c) => (c.num_members ?? 0) > 0)
    .sort((a, b) => (b.num_members ?? 0) - (a.num_members ?? 0))
    .slice(0, 3);

  const channelStats: Array<{
    id: string;
    name: string;
    messages_30d: number;
  }> = [];
  const allMsgs: { ts: number }[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    try {
      const msgs = await fetchChannelHistory(token, c.id, Math.floor(oldest30));
      const human = msgs
        .filter(isHumanMsg)
        .map((m) => ({ ts: parseFloat(m.ts) }));
      channelStats.push({
        id: c.id,
        name: c.name,
        messages_30d: human.length,
      });
      allMsgs.push(...human);
    } catch (e) {
      // チャンネルにbotが入ってない等。ログだけ残す
      console.warn("slack history skipped:", c.name, (e as Error).message);
    }
    // Tier1: 1分1req → 安全側で61秒待つのは現実的でないため
    // 上位3件に絞ることで対応。それでも429時はリトライせず次へ。
    if (i < candidates.length - 1) {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  return {
    channels_total: channels.length,
    channels_analyzed: channelStats.length,
    top_channels: channelStats.sort((a, b) => b.messages_30d - a.messages_30d),
    weekly_message_counts: weeklyBuckets(allMsgs, now),
    night_message_ratio: nightRatio(allMsgs),
    fetched_at: new Date().toISOString(),
  };
}

// ==================== Chatwork ====================

async function ensureFreshChatworkToken(integ: any) {
  if (!integ.token_expires_at) return integ;
  if (new Date(integ.token_expires_at).getTime() > Date.now() + 30_000)
    return integ;
  await fetch(`${SUPABASE_URL}/functions/v1/chatwork-oauth/refresh`, {
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

async function chatworkApi(token: string, path: string) {
  const r = await fetch(`https://api.chatwork.com/v2${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok)
    throw new Error(`chatwork ${path} failed: ${r.status} ${await r.text()}`);
  return await r.json();
}

interface ChatworkRoom {
  room_id: number;
  name: string;
  unread_num: number;
  message_num: number;
  last_update_time: number;
}

interface ChatworkMessage {
  message_id: string;
  send_time: number;
}

async function syncChatwork(integ: any) {
  const fresh = await ensureFreshChatworkToken(integ);
  const token = fresh.access_token;

  const rooms = (await chatworkApi(token, "/rooms")) as ChatworkRoom[];

  const totalUnread = rooms.reduce((s, r) => s + (r.unread_num || 0), 0);

  // 最近 last_update_time が新しい上位3ルームのみ
  const topRooms = rooms
    .sort((a, b) => (b.last_update_time || 0) - (a.last_update_time || 0))
    .slice(0, 3);

  const now = Date.now() / 1000;
  const oldest30 = now - 30 * 86400;
  const allMsgs: { ts: number }[] = [];
  const roomStats: Array<{
    room_id: number;
    name: string;
    messages_30d: number;
    unread: number;
  }> = [];

  for (const room of topRooms) {
    try {
      const msgs = (await chatworkApi(
        token,
        `/rooms/${room.room_id}/messages?force=1`,
      )) as ChatworkMessage[];
      const recent = (msgs || []).filter((m) => m.send_time >= oldest30);
      roomStats.push({
        room_id: room.room_id,
        name: room.name,
        messages_30d: recent.length,
        unread: room.unread_num || 0,
      });
      for (const m of recent) allMsgs.push({ ts: m.send_time });
    } catch (e) {
      console.warn(
        "chatwork room skipped:",
        room.room_id,
        (e as Error).message,
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  return {
    rooms_total: rooms.length,
    rooms_analyzed: roomStats.length,
    top_rooms: roomStats.sort((a, b) => b.messages_30d - a.messages_30d),
    weekly_message_counts: weeklyBuckets(allMsgs, now),
    total_unread: totalUnread,
    fetched_at: new Date().toISOString(),
  };
}

// ==================== handler ====================

serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const { company_id } = body as { company_id?: string };
    if (!company_id) return jsonResp({ error: "company_id が必要です" }, 400);

    const supa = getServiceClient();
    const { data: integrations } = await supa
      .from("integrations")
      .select("*")
      .eq("company_id", company_id)
      .in("type", ["slack", "chatwork"])
      .eq("status", "connected");

    if (!integrations || integrations.length === 0) {
      return jsonResp({ success: true, synced: 0, message: "未連携" });
    }

    const expiresAt = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const results: Record<string, unknown> = {};

    for (const integ of integrations) {
      try {
        let content: unknown;
        if (integ.type === "slack") {
          content = await syncSlack(integ);
        } else if (integ.type === "chatwork") {
          content = await syncChatwork(integ);
        } else {
          continue;
        }

        await supa.from("external_data").insert({
          company_id,
          source_type: integ.type,
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

        results[integ.type] = { success: true, summary: content };
      } catch (e) {
        captureError(e as Error, { company_id, extra: { type: integ.type } });
        await supa
          .from("integrations")
          .update({ status: "error" })
          .eq("id", integ.id);
        results[integ.type] = { success: false, error: (e as Error).message };
      }
    }

    return jsonResp({ success: true, results });
  } catch (e) {
    captureError(e as Error);
    return jsonResp({ error: (e as Error).message }, 500);
  }
});
