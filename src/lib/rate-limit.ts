import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

/**
 * API のレート制限（2026-09-13 の点検・PR-2a）。
 *
 * ## なぜ要るか
 *
 * `src/app/api/**` にレート制限が1つも無かった。`csv/analyze` と `competitors/suggest` は
 * 認証済みなら**無制限に Anthropic を呼び**、`auth/session` の登録・ログインには関門が無かった。
 *
 * 数えるのは Postgres の `hit_rate_limit`（00049）。**1文で数えて返す**ので、
 * 同時に届いた要求で上限を超えない。
 *
 * ## 上限は環境変数で変えられる
 *
 * 既定値は発注の初期値。**本番で詰まったときに、コードを変えずに緩められる**ようにする。
 */

export interface RateRule {
  /** `api_rate_limits.route` に入る名前 */
  route: string;
  /** 窓の長さ（秒） */
  windowSeconds: number;
  /** 窓の中で許す回数 */
  limit: number;
  /**
   * **数えられなかったときに止めるか。**
   *
   * LLM の費用が出る経路（analyze / suggest）は止める（503）。
   * 取り込みとログインは止めない——制限の障害で業務と入口が止まる形にしない
   */
  failClosed: boolean;
}

const DAY = 86_400;

/** 環境変数から上限を読む。**読めなければ既定値**（0 や負にしない） */
function envLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** 発注の初期値。`RATE_LIMIT_*` で上書きできる */
export function rateRules(): Record<"analyze" | "suggest" | "ingest" | "session", RateRule> {
  return {
    analyze: {
      route: "csv/analyze",
      windowSeconds: DAY,
      limit: envLimit("RATE_LIMIT_ANALYZE_PER_DAY", 20),
      failClosed: true,
    },
    suggest: {
      route: "competitors/suggest",
      windowSeconds: DAY,
      limit: envLimit("RATE_LIMIT_SUGGEST_PER_DAY", 5),
      failClosed: true,
    },
    ingest: {
      route: "csv/ingest",
      windowSeconds: DAY,
      limit: envLimit("RATE_LIMIT_INGEST_PER_DAY", 20),
      failClosed: false,
    },
    session: {
      route: "auth/session",
      windowSeconds: 600,
      limit: envLimit("RATE_LIMIT_SESSION_PER_10MIN", 30),
      failClosed: false,
    },
  };
}

/** その時刻が属する窓の始まり。**窓の境界を揃える**（同じ窓なら同じ行に数える） */
export function rateWindowStart(now: Date, windowSeconds: number): Date {
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

export type RateDecision =
  | { allowed: true; count: number }
  /** 上限を超えた（429） */
  | { allowed: false; reason: "limited"; count: number; retryAfterSeconds: number }
  /** 数えられず、`failClosed` の経路なので止めた（503） */
  | { allowed: false; reason: "unavailable" };

/**
 * 数えた件数から、通すかを決める。**判断だけを持つ。**
 *
 * `count` は**数えた後**の件数（この要求を含む）。上限ちょうどは通し、超えたら止める。
 */
export function decideRate(count: number, rule: RateRule, now: Date): RateDecision {
  if (count <= rule.limit) return { allowed: true, count };
  const end = rateWindowStart(now, rule.windowSeconds).getTime() + rule.windowSeconds * 1000;
  const retryAfterSeconds = Math.max(1, Math.ceil((end - now.getTime()) / 1000));
  return { allowed: false, reason: "limited", count, retryAfterSeconds };
}

/**
 * 数えられなかったときの判断。**経路ごとに違う**（`RateRule.failClosed`）。
 *
 * - analyze / suggest: 止める。数えられないまま通すと、DB の障害の間は
 *   **上限なしで Anthropic を呼べる**
 * - ingest / session: 通す。制限の障害で取り込みとログインを止めない
 */
export function decideUnavailable(rule: RateRule): RateDecision {
  return rule.failClosed ? { allowed: false, reason: "unavailable" } : { allowed: true, count: 0 };
}

/** 数える対象。**会社単位か IP 単位か**を文字列の接頭辞で分ける（00049） */
export function companySubject(companyId: string): string {
  return `company:${companyId}`;
}
export function ipSubject(ip: string): string {
  return `ip:${ip}`;
}

/**
 * 要求元の IP を取る。**Vercel では `x-forwarded-for` の先頭が本当の送信元である。**
 *
 * 取れなければ `unknown` にまとめて数える。**取れないことを「制限しない」にしない**——
 * ヘッダを消せば無制限に通る形を作らない。
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return first;
  return headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * 1回数えて判断する。**数えるのは service_role**（利用者は件数を触れない）。
 *
 * 数えられなかったとき（DB に届かない）は `decideUnavailable` に従う。
 * どちらの場合も黙らない——ログに残す。
 */
export async function hitRate(
  subject: string,
  rule: RateRule,
  now: Date = new Date(),
): Promise<RateDecision> {
  const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data, error } = await admin.rpc("hit_rate_limit", {
    p_subject: subject,
    p_route: rule.route,
    p_window_start: rateWindowStart(now, rule.windowSeconds).toISOString(),
  });

  if (error || typeof data !== "number") {
    const decision = decideUnavailable(rule);
    console.error(
      `rate-limit: 数えられなかった route=${rule.route} → ${decision.allowed ? "通す" : "止める"}:`,
      error?.message ?? "no count",
    );
    return decision;
  }
  return decideRate(data, rule, now);
}

/**
 * 止めたときの応答。上限超えは **429 と Retry-After**、
 * 数えられずに止めたときは **503（reason: rate_limit_unavailable）**
 */
export function rateLimitedResponse(
  decision: Extract<RateDecision, { allowed: false }>,
): NextResponse {
  if (decision.reason === "unavailable") {
    return NextResponse.json(
      { error: "service_unavailable", reason: "rate_limit_unavailable" },
      { status: 503 },
    );
  }
  return NextResponse.json(
    { error: "rate_limited", retry_after_seconds: decision.retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(decision.retryAfterSeconds) } },
  );
}
