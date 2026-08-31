// 配信ディスパッチャ（daily）— 契約 docs/contracts/slice-cron-dispatch.md（スライスCD）
//
// cron はこの関数だけを叩く。deliver-* の引数要件（email 必須）を cron に漏らさない。
// 判断は _shared/dispatch.ts の純ロジックに閉じてあり、陰性コントロールは
// tests/unit/dispatch.test.ts が当てている。

import { corsHeaders } from "../_shared/cors.ts";
import { resolveCaller } from "../_shared/caller.ts";
import { errorResponse } from "../_shared/db.ts";
import { runDispatch } from "../_shared/dispatch.ts";
import { buildDeps } from "../_shared/dispatch-runtime.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 呼び出し元の判定は**DBに触る前**（契約 S-2-9 / ADR-0002）
  const caller = await resolveCaller(req);
  if (!caller.ok) return caller.response;

  try {
    // internal 以外は対象の列挙にも到達させない（CD-3-2）
    const result = await runDispatch("daily", caller.caller, buildDeps());

    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return errorResponse(error, corsHeaders);
  }
});
