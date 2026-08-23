// Investigator のスタブ。**本番には出さない。**
//
// 契約 S-3-1。CI には `ANTHROPIC_API_KEY` を置かない方針（ci.yml のガードで機械的に固定）
// なので、実物の `investigate` は CI では必ず失敗する。一気通貫を CI で通すために、
// `run-sense` の宛先（`INVESTIGATE_URL`）をこちらへ向ける。
//
// **本番に出ていないことの担保は2つ。**
// 1. `.github/workflows/deploy.yml` に `supabase functions deploy investigate-stub` が無い。
//    デプロイ対象は明示stepの列挙で、ディレクトリ走査ではない
// 2. `scripts/check-caller-guard.ts` は対象を deploy.yml から導出するので、
//    ここが対象外であることと deploy されないことが同じ1つの事実に紐づく
//
// LLM は呼ばない。S-3 の主題はパイプラインの配線であって Investigator の中身ではない
// （中身は `eval/` のエンジン評価スイートが担保する）。

import { corsHeaders } from "../_shared/cors.ts";
import { resolveCaller } from "../_shared/caller.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 実物と同じく internal 限定。スタブだからといって素通しの口を作らない
  const caller = await resolveCaller(req);
  if (!caller.ok) return caller.response;

  const { company_id, candidates } = await req.json();

  // findings は INSERT しない。S-3-2（findings 1件以上）は run-sense の
  // 事実アラート高速路（immediates）が満たす。ここで作ると
  // 「Investigator が動いた」ことと区別がつかなくなる
  return new Response(
    JSON.stringify({
      status: "ok",
      stub: true,
      company_id,
      received_candidates: Array.isArray(candidates) ? candidates.length : 0,
      findings: [],
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
