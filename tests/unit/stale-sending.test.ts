/**
 * `sending` のまま固まった行を掃除する（発注 ①-4）。
 *
 * ## 直す前に何が起きていたか
 *
 * `deliverOnce` は「予約（`sending`）→ 送信 → 更新」で動く。**真ん中で落ちると
 * `sending` のまま残る。** `RETRYABLE` は `failed` と `deferred` だけなので、
 * その行は**二度と再送されない。** `deliverOnce` は `in-flight` と読んで飛ばす。
 *
 * その判断自体は短時間なら正しい——送った直後に落ちた場合と区別が付かず、
 * 二重送信のほうが害が大きい。**ただし2時間も `sending` なら送信中ではありえない。**
 *
 * ここは純関数（判断）の試験である。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ABANDONED,
  MAX_SEND_ATTEMPTS,
  STALE_SENDING,
  STALE_SENDING_HOURS,
  planStaleSweep,
  type StaleRow,
} from "@edge/_shared/stale-sending";

const NOW = new Date("2026-09-10T12:00:00.000Z");

/** NOW から `hours` 時間前の ISO 文字列 */
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3600_000).toISOString();

const row = (over: Partial<StaleRow> = {}): StaleRow => ({
  id: "row-1",
  status: "sending",
  attempts: 1,
  created_at: ago(3),
  ...over,
});

describe("2時間を超えた sending だけを倒す", () => {
  it("3時間前の sending は failed に倒して、同じ実行で再送に回す", () => {
    expect(planStaleSweep([row()], NOW)).toEqual({ retry: ["row-1"], abandon: [] });
  });

  it("**陰性**: 1時間前の sending は触らない（送信中かもしれない）", () => {
    expect(planStaleSweep([row({ created_at: ago(1) })], NOW)).toEqual({ retry: [], abandon: [] });
  });

  it("境界（ちょうど2時間）は倒す側に倒す", () => {
    const exact = row({ created_at: ago(STALE_SENDING_HOURS) });
    expect(planStaleSweep([exact], NOW).retry).toEqual(["row-1"]);
  });

  it("**陰性**: sending 以外は1行も触らない", () => {
    for (const status of ["sent", "failed", "deferred", "skipped", "draft", "confirmed", ABANDONED]) {
      const out = planStaleSweep([row({ status, created_at: ago(99) })], NOW);
      expect(out, status).toEqual({ retry: [], abandon: [] });
    }
  });

  it("**陰性**: created_at が読めない行は触らない（いま送信中の行を横から倒さない）", () => {
    for (const created_at of [null, "壊れた値"]) {
      const out = planStaleSweep([row({ created_at })], NOW);
      expect(out, String(created_at)).toEqual({ retry: [], abandon: [] });
    }
  });
});

describe("上限に達した行は諦めた側へ移す", () => {
  it("3回試した行は abandoned に移す（failed に倒しても次で弾かれるだけ）", () => {
    const out = planStaleSweep([row({ attempts: MAX_SEND_ATTEMPTS })], NOW);
    expect(out).toEqual({ retry: [], abandon: ["row-1"] });
  });

  it("2回までは再送に回す", () => {
    expect(planStaleSweep([row({ attempts: 2 })], NOW).retry).toEqual(["row-1"]);
  });

  it("attempts が壊れていても数え直せる（null は 0 として扱う）", () => {
    expect(planStaleSweep([row({ attempts: null })], NOW).retry).toEqual(["row-1"]);
  });

  it("上限は delivery.ts と同じ 3 である", () => {
    expect(MAX_SEND_ATTEMPTS).toBe(3);
  });
});

describe("配る前に掃除が走る", () => {
  const dispatch = readFileSync(
    path.resolve(__dirname, "../../supabase/functions/_shared/dispatch.ts"),
    "utf8",
  );

  it("掃除は会社を回す前にある（倒した行がこの実行の再送対象になる）", () => {
    const sweepAt = dispatch.indexOf("deps.sweepStaleSending");
    const loopAt = dispatch.indexOf("for (const target of targets)");
    expect(sweepAt).toBeGreaterThan(-1);
    expect(loopAt).toBeGreaterThan(-1);
    expect(sweepAt).toBeLessThan(loopAt);
  });

  it("要約に件数が出る（**0件でも必ず出す**）", () => {
    expect(dispatch).toContain("stale_swept: 0");
    expect(dispatch).toContain("abandoned: 0");
  });

  it("掃除の失敗で配信を止めない", () => {
    // 取りこぼしを拾う機能であって、配信の前提ではない
    expect(dispatch).toContain('console.error("dispatch: sending の掃除に失敗:", swept.error)');
  });
});

describe("Resend に同じ冪等キーを渡す", () => {
  const mailer = readFileSync(
    path.resolve(__dirname, "../../supabase/functions/_shared/mailer.ts"),
    "utf8",
  );
  const delivery = readFileSync(
    path.resolve(__dirname, "../../supabase/functions/_shared/delivery.ts"),
    "utf8",
  );

  it("ヘッダに Idempotency-Key を載せる", () => {
    expect(mailer).toContain('"Idempotency-Key": idempotencyKey');
  });

  it("**陰性**: 鍵が無ければヘッダごと出さない（空文字を送らない）", () => {
    expect(mailer).toContain("...(idempotencyKey ? {");
  });

  it("鍵は呼び出し元に写させず、deliverOnce が予約に使った値を渡す", () => {
    // 写す形にすると、写し間違えても誰も気づかない
    expect(delivery).toContain("send(input.idempotencyKey)");
  });

  it("倒した行の理由は stale_sending で、abandoned とは別の値である", () => {
    expect(STALE_SENDING).toBe("stale_sending");
    expect(ABANDONED).toBe("abandoned");
  });
});
