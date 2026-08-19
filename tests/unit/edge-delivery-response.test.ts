import { describe, it, expect } from "vitest";
import { deliveryResponse } from "@edge/_shared/delivery-response";
import type { DeliverResult } from "@edge/_shared/delivery";

/**
 * S-2-3 / S-2-6。
 *
 * ここで固定したいのは1点に尽きる:
 * **「メールは出たのに 5xx」を、レスポンスから見分けられること。**
 * 見分けられないと、運用側が「失敗したから再実行しよう」と判断して2通目を出す。
 */

async function body(result: DeliverResult) {
  const res = deliveryResponse(result, { company_id: "c1" });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("deliveryResponse", () => {
  it("送信成功は 200 で email_sent: true", async () => {
    const r = await body({ outcome: "sent", id: "d1", emailId: "re_1", attempts: 1 });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "ok", email_sent: true, email_id: "re_1" });
  });

  it("**送信済みなのに記録失敗**は 5xx だが email_sent: true で判別できる (S-2-6)", async () => {
    const r = await body({
      outcome: "sent-but-unrecorded",
      id: "d1",
      emailId: "re_1",
      error: "connection reset",
    });
    expect(r.status).toBe(500);
    expect(r.json.email_sent).toBe(true);
    expect(r.json.email_id).toBe("re_1");
  });

  it("送信失敗は 502 で email_sent: false（送っていないと言い切れる）", async () => {
    const r = await body({ outcome: "send-failed", id: "d1", error: "Resend 422", attempts: 1 });
    expect(r.status).toBe(502);
    expect(r.json.email_sent).toBe(false);
    expect(r.json.reason).toContain("422");
  });

  it("重複スキップは 200。0件やスキップを異常系にしない (S-2-3)", async () => {
    const r = await body({
      outcome: "skipped",
      id: "d1",
      reason: "already-sent",
      status: "sent",
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "skipped", reason: "already-sent", email_sent: true });
  });

  it("in-flight の重複スキップは email_sent を true とも false とも言わない", async () => {
    const r = await body({
      outcome: "skipped",
      id: "d1",
      reason: "in-flight",
      status: "sending",
    });
    expect(r.status).toBe(200);
    // 「送った可能性がある」を false と書くと、運用が再送してよいと読む
    expect(r.json.email_sent).toBeNull();
  });

  it("再試行上限は 5xx で顕在化する（黙って 200 にしない）", async () => {
    const r = await body({ outcome: "attempts-exhausted", id: "d1", attempts: 3 });
    expect(r.status).toBe(500);
    expect(r.json).toMatchObject({ status: "error", attempts: 3, email_sent: false });
  });

  it("繰り延べは 200 の正常系", async () => {
    const r = await body({ outcome: "deferred", id: "d1" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "deferred", email_sent: false });
  });

  it("呼び出し元が渡した文脈（company_id 等）が失われない", async () => {
    const r = await body({ outcome: "sent", id: "d1", emailId: "re_1", attempts: 1 });
    expect(r.json.company_id).toBe("c1");
  });
});
