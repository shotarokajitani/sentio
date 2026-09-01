import { describe, it, expect } from "vitest";
import {
  shouldDeliverNow,
  isQuietHour,
  QUIET_START_HOUR,
  QUIET_END_HOUR,
  QUIET_HOUR_EXCEPTIONS,
  type DeliveryInput,
} from "../../src/act/quiet-hours";
import * as edge from "@edge/_shared/quiet-hours";

describe("Quiet hours (E5)", () => {
  it("23:00-6:00 non-exception alerts are deferred to next morning", () => {
    const input: DeliveryInput = {
      urgency: "immediate",
      category: "ssl_expiry",
    };
    const result = shouldDeliverNow(input, new Date("2026-07-01T23:30:00+09:00"));
    expect(result.deliver).toBe(false);
    expect(result.deferUntil).toBeDefined();
    // Should defer to 6:00 AM next day JST
    expect(result.deferUntil!.toISOString()).toBe(
      new Date("2026-07-02T06:00:00+09:00").toISOString(),
    );
  });

  it("site_down is delivered even during quiet hours (ongoing loss exception)", () => {
    const input: DeliveryInput = {
      urgency: "immediate",
      category: "site_down",
    };
    const result = shouldDeliverNow(input, new Date("2026-07-01T02:00:00+09:00"));
    expect(result.deliver).toBe(true);
  });

  it("after 6:00 delivers normally", () => {
    const input: DeliveryInput = {
      urgency: "immediate",
      category: "ssl_expiry",
    };
    const result = shouldDeliverNow(input, new Date("2026-07-01T06:01:00+09:00"));
    expect(result.deliver).toBe(true);
  });

  it("before 23:00 delivers normally", () => {
    const input: DeliveryInput = {
      urgency: "immediate",
      category: "payment_overdue",
    };
    const result = shouldDeliverNow(input, new Date("2026-07-01T22:59:00+09:00"));
    expect(result.deliver).toBe(true);
  });

  it("weekly urgency always delivers (not subject to quiet hours)", () => {
    const input: DeliveryInput = {
      urgency: "weekly",
      category: "finding",
    };
    const result = shouldDeliverNow(input, new Date("2026-07-01T03:00:00+09:00"));
    expect(result.deliver).toBe(true);
  });

  it("midnight exactly is in quiet hours", () => {
    const input: DeliveryInput = {
      urgency: "immediate",
      category: "ssl_expiry",
    };
    const result = shouldDeliverNow(input, new Date("2026-07-02T00:00:00+09:00"));
    expect(result.deliver).toBe(false);
  });
});

/**
 * 静音時間の規則は**2箇所にある**。
 *
 * - `src/act/quiet-hours.ts`（正本。配信判断のロジックを持つ）
 * - `supabase/functions/_shared/quiet-hours.ts`（Edge Function 側の写し）
 *
 * Edge Function は `supabase/functions/` の外を import できないため二重に持つ。
 * これは `retention` 対と同じ形であり、**同じ止め具を付ける**
 * （`tests/unit/retention-policy.test.ts` の「Edge 側と Next.js 側でポリシーがずれていない」）。
 *
 * **止め具が無いと、片方だけ直した日に「直したはずの側が動いていない」が起きる。**
 * 2026-08-31 の監査時点で Edge 側は 23 / 6 をリテラルで直書きしており、
 * `src` の定数を変えても Edge は変わらない状態だった。
 */
describe("Edge 側と Next.js 側で静音時間の規則がずれていない", () => {
  it("静音時間の開始と終了が一致する", () => {
    expect(edge.QUIET_START_HOUR).toBe(QUIET_START_HOUR);
    expect(edge.QUIET_END_HOUR).toBe(QUIET_END_HOUR);
  });

  it("例外カテゴリの集合が一致する", () => {
    expect([...edge.QUIET_HOUR_EXCEPTIONS].sort()).toEqual([...QUIET_HOUR_EXCEPTIONS].sort());
  });

  it("24時間すべての時刻で判定が一致する（片側だけ直した日に赤くする）", () => {
    for (let hour = 0; hour < 24; hour++) {
      // JST の各正時を UTC で作る
      const at = new Date(Date.UTC(2026, 6, 1, (hour - 9 + 24) % 24, 30, 0));
      expect(edge.isQuietHour(at), `JST ${hour}:30`).toBe(isQuietHour(at));
    }
  });

  it("境界（22:59 / 23:00 / 05:59 / 06:00 JST）で一致する", () => {
    for (const iso of [
      "2026-07-01T22:59:59+09:00",
      "2026-07-01T23:00:00+09:00",
      "2026-07-02T05:59:59+09:00",
      "2026-07-02T06:00:00+09:00",
    ]) {
      const at = new Date(iso);
      expect(edge.isQuietHour(at), iso).toBe(isQuietHour(at));
    }
  });
});
