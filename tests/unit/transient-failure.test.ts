/**
 * 一時的な失敗と、本当に切れたのを分ける（発注 ①-2）。
 *
 * ## 直す前に何が起きていたか（2026-09-09 の実測）
 *
 * `classifyTokenFailure` は `status !== 400` を**すべて** `reauth_required` にしていた。
 * fetch の例外・Vault の読み取り失敗も、分類器を通らずに直接倒していた。
 * 倒れた行は `sync-connections` の対象（`status = 'active'`）から外れ、
 * **顧客が手で再連携するまで直らない。** その間、7日ごとに「連携が切れています」が届く。
 *
 * **ネットワークが1回瞬断しただけで、この状態になっていた。**
 *
 * ここは純関数（判断）の試験である。実DBに当てる側は
 * `tests/integration/token-refresh.test.ts` が持つ。
 */
import { describe, it, expect } from "vitest";
import {
  MAX_CONSECUTIVE_FAILURES,
  REAUTH_RETRY_HOURS,
  classifyTokenFailure,
  planTransientFailure,
  shouldRetryReauth,
} from "@edge/_shared/token-refresh";

const NOW = new Date("2026-09-10T00:00:00.000Z");

describe("失敗を3種に分ける", () => {
  it("400 かつ invalid_grant は revoked（従来どおり）", () => {
    expect(classifyTokenFailure(400, JSON.stringify({ error: "invalid_grant" }))).toBe("revoked");
  });

  it("400 で invalid_grant 以外は reauth_required", () => {
    expect(classifyTokenFailure(400, JSON.stringify({ error: "invalid_request" }))).toBe(
      "reauth_required",
    );
  });

  it("401 は reauth_required", () => {
    expect(classifyTokenFailure(401, "")).toBe("reauth_required");
  });

  it("**陰性**: 5xx は transient（連携を切らない）", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyTokenFailure(status, "Service Unavailable"), String(status)).toBe("transient");
    }
  });

  it("**陰性**: 408 と 429 も transient", () => {
    expect(classifyTokenFailure(408, "")).toBe("transient");
    expect(classifyTokenFailure(429, "")).toBe("transient");
  });

  it("**陰性**: 5xx の本文に invalid_grant が入っていても revoked にしない", () => {
    // 障害時のプロキシは上流の本文をそのまま返すことがある。
    // ここで revoked に倒すと、Vault の秘密を破棄して30日削除の起点が立つ
    expect(classifyTokenFailure(503, JSON.stringify({ error: "invalid_grant" }))).toBe("transient");
  });

  it("知らない状態コードは transient（認可の失敗と断定しない）", () => {
    for (const status of [402, 403, 404, 418]) {
      expect(classifyTokenFailure(status, ""), String(status)).toBe("transient");
    }
  });
});

describe("一時的な失敗は3回目で倒す", () => {
  it("1回目・2回目は倒さない（**状態を変えない**）", () => {
    expect(planTransientFailure(0)).toEqual({ failures: 1, escalate: false });
    expect(planTransientFailure(1)).toEqual({ failures: 2, escalate: false });
  });

  it("3回目で倒す", () => {
    expect(planTransientFailure(2)).toEqual({ failures: 3, escalate: true });
  });

  it("回数が壊れていても数え直せる（null / NaN は 0 として扱う）", () => {
    expect(planTransientFailure(Number.NaN)).toEqual({ failures: 1, escalate: false });
  });

  it("上限は定数1つで決まる", () => {
    expect(MAX_CONSECUTIVE_FAILURES).toBe(3);
    expect(planTransientFailure(MAX_CONSECUTIVE_FAILURES - 1).escalate).toBe(true);
    expect(planTransientFailure(MAX_CONSECUTIVE_FAILURES - 2).escalate).toBe(false);
  });
});

describe("reauth_required の再試行は1日1回", () => {
  it("24時間経っていれば再試行する", () => {
    const long = new Date(NOW.getTime() - (REAUTH_RETRY_HOURS + 1) * 3600_000).toISOString();
    expect(shouldRetryReauth(long, NOW)).toBe(true);
  });

  it("**陰性**: 24時間経っていなければ試さない（相手に無駄な負荷をかけない）", () => {
    const short = new Date(NOW.getTime() - (REAUTH_RETRY_HOURS - 1) * 3600_000).toISOString();
    expect(shouldRetryReauth(short, NOW)).toBe(false);
  });

  it("境界（ちょうど24時間）は試す側に倒す", () => {
    const exact = new Date(NOW.getTime() - REAUTH_RETRY_HOURS * 3600_000).toISOString();
    expect(shouldRetryReauth(exact, NOW)).toBe(true);
  });

  it("失敗の記録が無い行は試す（**放置され続けるほうが害が大きい**）", () => {
    // この変更より前から reauth_required だった行がここに当たる
    expect(shouldRetryReauth(null, NOW)).toBe(true);
    expect(shouldRetryReauth("壊れた値", NOW)).toBe(true);
  });
});
