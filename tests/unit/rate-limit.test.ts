/**
 * レート制限の判断（2026-09-13 の点検・PR-2a）。**判断だけを見る。**
 *
 * 数えるのは DB（00049 の `hit_rate_limit`）で、そちらは `tests/integration/rate-limit.test.ts` が
 * 実 DB で確かめる。ここは「何回目で止めるか」「いつまで待たせるか」「誰として数えるか」。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  clientIp,
  companySubject,
  decideRate,
  decideUnavailable,
  ipSubject,
  rateRules,
  rateLimitedResponse,
  rateWindowStart,
} from "@/lib/rate-limit";

const DAY_RULE = { route: "test", windowSeconds: 86_400, limit: 5, failClosed: false };

describe("何回目で止めるか", () => {
  const now = new Date("2026-09-13T10:00:00Z");

  it("上限ちょうど（5回目）は通す", () => {
    expect(decideRate(5, DAY_RULE, now)).toEqual({ allowed: true, count: 5 });
  });

  it("**陰性**: 上限を1つ超えた回（6回目）は止める", () => {
    const d = decideRate(6, DAY_RULE, now);
    expect(d.allowed).toBe(false);
  });

  it("止めたときは窓の終わりまでの秒数を返す（UTC 10:00 → 翌 00:00 まで 14 時間）", () => {
    const d = decideRate(6, DAY_RULE, now);
    expect(d).toEqual({
      allowed: false,
      reason: "limited",
      count: 6,
      retryAfterSeconds: 14 * 3600,
    });
  });

  it("窓の終わりの直前でも Retry-After は 1 秒以上", () => {
    const d = decideRate(6, DAY_RULE, new Date("2026-09-13T23:59:59.900Z"));
    expect(d.allowed === false && d.reason === "limited" && d.retryAfterSeconds).toBe(1);
  });

  it("10分の窓: 10:07 は 10:00 の窓に入り、残りは 3 分", () => {
    const rule = { route: "s", windowSeconds: 600, limit: 30, failClosed: false };
    const at = new Date("2026-09-13T10:07:00Z");
    expect(rateWindowStart(at, 600).toISOString()).toBe("2026-09-13T10:00:00.000Z");
    expect(decideRate(31, rule, at)).toEqual({
      allowed: false,
      reason: "limited",
      count: 31,
      retryAfterSeconds: 180,
    });
  });
});

describe("止めたときの応答", () => {
  it("上限超えは status 429 と Retry-After を持つ", async () => {
    const res = rateLimitedResponse({
      allowed: false,
      reason: "limited",
      count: 6,
      retryAfterSeconds: 120,
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("120");
    expect(await res.json()).toEqual({ error: "rate_limited", retry_after_seconds: 120 });
  });

  it("数えられずに止めたときは 503（reason: rate_limit_unavailable）", async () => {
    const res = rateLimitedResponse({ allowed: false, reason: "unavailable" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "service_unavailable",
      reason: "rate_limit_unavailable",
    });
  });
});

describe("数えられなかったとき（DB に届かない）", () => {
  it("**陰性**: LLM の費用が出る analyze と suggest は止める", () => {
    const r = rateRules();
    expect(decideUnavailable(r.analyze)).toEqual({ allowed: false, reason: "unavailable" });
    expect(decideUnavailable(r.suggest)).toEqual({ allowed: false, reason: "unavailable" });
  });

  it("ingest と session は通す（制限の障害で取り込みとログインを止めない）", () => {
    const r = rateRules();
    expect(decideUnavailable(r.ingest)).toEqual({ allowed: true, count: 0 });
    expect(decideUnavailable(r.session)).toEqual({ allowed: true, count: 0 });
  });
});

describe("上限の既定値と環境変数", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("発注の初期値: analyze 20/日・suggest 5/日・ingest 20/日・session 30/10分", () => {
    const r = rateRules();
    expect([r.analyze.limit, r.suggest.limit, r.ingest.limit, r.session.limit]).toEqual([
      20, 5, 20, 30,
    ]);
    expect([r.analyze.windowSeconds, r.session.windowSeconds]).toEqual([86_400, 600]);
  });

  it("環境変数で上書きできる", () => {
    vi.stubEnv("RATE_LIMIT_SUGGEST_PER_DAY", "8");
    expect(rateRules().suggest.limit).toBe(8);
  });

  it("**陰性**: 0・負・数でない値は既定値に戻す（上限を外す形にしない）", () => {
    for (const bad of ["0", "-1", "abc", "2.5", ""]) {
      vi.stubEnv("RATE_LIMIT_SESSION_PER_10MIN", bad);
      expect(rateRules().session.limit, `値 "${bad}"`).toBe(30);
    }
  });
});

describe("誰として数えるか", () => {
  it("会社と IP は接頭辞で分かれる（同じ文字列でも別に数える）", () => {
    expect(companySubject("abc")).toBe("company:abc");
    expect(ipSubject("abc")).toBe("ip:abc");
  });

  it("x-forwarded-for の先頭を送信元にする", () => {
    const h = new Headers({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" });
    expect(clientIp(h)).toBe("203.0.113.5");
  });

  it("x-forwarded-for が無ければ x-real-ip", () => {
    expect(clientIp(new Headers({ "x-real-ip": "198.51.100.7" }))).toBe("198.51.100.7");
  });

  it("**陰性**: どちらも無ければ unknown にまとめて数える（ヘッダを消しても無制限にならない）", () => {
    expect(clientIp(new Headers())).toBe("unknown");
    expect(clientIp(new Headers({ "x-forwarded-for": " , " }))).toBe("unknown");
  });
});
