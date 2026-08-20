/**
 * `DeliverResult` を HTTP に写す（契約 S-2-3 / S-2-6）。
 *
 * 4本の配信 Function で同じ写像を使う。関数ごとに書くと、
 * 「送信済みなのに 5xx」の判別可能性が1本だけ抜ける、が起きる。
 *
 * 写像の骨子:
 *
 * | 結果                  | HTTP | 意味                                                   |
 * | --------------------- | ---- | ------------------------------------------------------ |
 * | `sent`                | 200  | 送信成功                                               |
 * | `deferred`            | 200  | 静音時間で繰り延べ（正常系）                           |
 * | `skipped`             | 200  | 同じ冪等キーで既に処理済み。**再送しないことが正常**   |
 * | `send-failed`         | 502  | 送っていない。外部APIの失敗                            |
 * | `sent-but-unrecorded` | 500  | **送信は完了している。**記録だけ失敗した               |
 * | `attempts-exhausted`  | 500  | 再試行上限。黙って止まらせない                         |
 *
 * `sent-but-unrecorded` を 200 にしないのは、記録が壊れている事実を運用に出すため。
 * 200 にすると「成功した」と読まれ、`sending` のまま固まった行が誰にも見られない。
 * 代わりに **`email_sent: true` を必ず載せる**（S-2-6 の「送信は完了していることが
 * レスポンスで判別できる」）。
 */

import { corsHeaders } from "./cors.ts";
import type { DeliverResult } from "./delivery.ts";

export function deliveryResponse(
  result: DeliverResult,
  extra: Record<string, unknown> = {},
): Response {
  const send = (status: number, body: Record<string, unknown>) =>
    new Response(JSON.stringify({ ...extra, ...body }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  switch (result.outcome) {
    case "sent":
      return send(200, {
        status: "ok",
        email_sent: true,
        email_id: result.emailId,
        delivery_id: result.id,
        attempts: result.attempts,
      });

    case "deferred":
      return send(200, { status: "deferred", email_sent: false, delivery_id: result.id });

    case "skipped":
      return send(200, {
        status: "skipped",
        // `in-flight` は「送った可能性がある」。送っていないとは言い切らない
        email_sent: result.reason === "already-sent" ? true : null,
        reason: result.reason,
        delivery_status: result.status,
        delivery_id: result.id,
      });

    case "send-failed":
      return send(502, {
        status: "error",
        email_sent: false,
        reason: result.error,
        delivery_id: result.id,
        attempts: result.attempts,
      });

    case "sent-but-unrecorded":
      return send(500, {
        status: "error",
        // **送信は完了している。**再試行してはいけないことがここで分かる
        email_sent: true,
        email_id: result.emailId,
        reason: `送信は完了したが delivery_log の更新に失敗した: ${result.error}`,
        delivery_id: result.id,
      });

    case "attempts-exhausted":
      return send(500, {
        status: "error",
        email_sent: false,
        reason: "再試行の上限に達したため送信しない",
        attempts: result.attempts,
        delivery_id: result.id,
      });
  }
}
