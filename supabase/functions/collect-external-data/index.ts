import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { initSentry, captureError } from "../_shared/sentry.ts";
import { getServiceClient, corsHeaders } from "../_shared/supabase.ts";

initSentry("collect-external-data");

const GOOGLE_PLACES_API_KEY = Deno.env.get("GOOGLE_PLACES_API_KEY");

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = getServiceClient();

  try {
    const { company_id, trigger } = (await req.json()) as {
      company_id: string;
      trigger: "registration" | "weekly_batch" | "manual";
    };

    if (!company_id) {
      return new Response(JSON.stringify({ error: "company_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: company } = await supabase
      .from("companies")
      .select("*")
      .eq("id", company_id)
      .single();

    if (!company) {
      return new Response(JSON.stringify({ error: "Company not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results: Record<string, string> = {};

    // A. URLスクレイピング（静的HTMLのみ）
    if (company.url) {
      try {
        const res = await fetch(company.url, {
          headers: { "User-Agent": "Sentio/1.0 (+https://www.sentio-ai.jp)" },
        });
        if (res.ok) {
          const html = await res.text();
          const text = html
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 5000);

          await supabase.from("external_data").insert({
            company_id,
            source: "company_site",
            data_type: "text",
            content: JSON.stringify({ url: company.url, text }),
            expires_at: new Date(
              Date.now() + 90 * 24 * 60 * 60 * 1000,
            ).toISOString(),
          });
          results.company_site = "ok";
        }
      } catch (e) {
        captureError(e as Error, {
          company_id,
          extra: { source: "company_site" },
        });
        results.company_site = "error";
      }

      // 同一ドメインへのリクエスト間隔: 1秒以上
      await delay(1000);
    }

    // B. Google Places API
    if (company.company_name && GOOGLE_PLACES_API_KEY) {
      try {
        const query = encodeURIComponent(company.company_name);
        const findRes = await fetch(
          `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${query}&inputtype=textquery&fields=place_id,name,rating,user_ratings_total&key=${GOOGLE_PLACES_API_KEY}`,
        );
        const findData = await findRes.json();

        if (findData.candidates && findData.candidates.length > 0) {
          const placeId = findData.candidates[0].place_id;

          await delay(1000);

          const detailRes = await fetch(
            `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,rating,user_ratings_total,reviews&language=ja&key=${GOOGLE_PLACES_API_KEY}`,
          );
          const detailData = await detailRes.json();

          if (detailData.result) {
            // レビューテキストの生データはDBに保存しない（処理後に破棄）
            const reviews = (detailData.result.reviews || []).map((r: any) => ({
              rating: r.rating,
              time: r.time,
              text_length: r.text?.length || 0,
              sentiment_keywords: extractKeywords(r.text || ""),
            }));

            await supabase.from("external_data").insert({
              company_id,
              source: "googlemap",
              data_type: "json",
              content: JSON.stringify({
                name: detailData.result.name,
                rating: detailData.result.rating,
                total_reviews: detailData.result.user_ratings_total,
                review_summary: reviews,
              }),
              expires_at: new Date(
                Date.now() + 180 * 24 * 60 * 60 * 1000,
              ).toISOString(),
            });
            results.googlemap = "ok";
          }
        }
      } catch (e) {
        captureError(e as Error, {
          company_id,
          extra: { source: "googlemap" },
        });
        results.googlemap = "error";
      }
    }

    // C. 求人情報（Google検索ベース簡易版）
    if (company.company_name) {
      try {
        const query = encodeURIComponent(`${company.company_name} 求人`);
        const searchRes = await fetch(
          `https://www.google.com/search?q=${query}&num=5`,
          { headers: { "User-Agent": "Sentio/1.0" } },
        );
        if (searchRes.ok) {
          const html = await searchRes.text();
          const hasJobPostings = /求人|採用|募集|キャリア/.test(html);

          await supabase.from("external_data").insert({
            company_id,
            source: "job_posting",
            data_type: "json",
            content: JSON.stringify({
              has_active_postings: hasJobPostings,
              checked_at: new Date().toISOString(),
            }),
            expires_at: new Date(
              Date.now() + 180 * 24 * 60 * 60 * 1000,
            ).toISOString(),
          });
          results.job_posting = "ok";
        }
      } catch (e) {
        captureError(e as Error, {
          company_id,
          extra: { source: "job_posting" },
        });
        results.job_posting = "error";
      }

      await delay(1000);
    }

    // D. 登記情報（国税庁法人番号公表サイトAPI）
    if (company.company_name) {
      try {
        const name = encodeURIComponent(company.company_name);
        const regRes = await fetch(
          `https://api.houjin-bangou.nta.go.jp/4/name?id=your_app_id&name=${name}&type=12&mode=2&kind=01`,
        );
        if (regRes.ok) {
          const regText = await regRes.text();
          await supabase.from("external_data").insert({
            company_id,
            source: "registration",
            data_type: "text",
            content: JSON.stringify({ raw: regText.slice(0, 2000) }),
            expires_at: new Date(
              Date.now() + 365 * 24 * 60 * 60 * 1000,
            ).toISOString(),
          });
          results.registration = "ok";
        }
      } catch (e) {
        captureError(e as Error, {
          company_id,
          extra: { source: "registration" },
        });
        results.registration = "error";
      }
    }

    // E. 業界統計（事前キャッシュ済みデータ）
    if (company.industry) {
      try {
        const { data: cached } = await supabase
          .from("industry_patterns")
          .select("*")
          .ilike("industry", `%${company.industry}%`)
          .limit(5);

        if (cached && cached.length > 0) {
          await supabase.from("external_data").insert({
            company_id,
            source: "industry_stats",
            data_type: "json",
            content: JSON.stringify({ patterns: cached }),
            expires_at: new Date(
              Date.now() + 365 * 24 * 60 * 60 * 1000,
            ).toISOString(),
          });
          results.industry_stats = "ok";
        }
      } catch (e) {
        captureError(e as Error, {
          company_id,
          extra: { source: "industry_stats" },
        });
        results.industry_stats = "error";
      }
    }

    // F. 競合情報（confirmed=trueのみ）
    try {
      const { data: competitors } = await supabase
        .from("competitors")
        .select("*")
        .eq("company_id", company_id)
        .eq("confirmed", true);

      if (competitors && competitors.length > 0) {
        for (const comp of competitors) {
          if (!comp.url) continue;
          try {
            await delay(1000);
            const compRes = await fetch(comp.url, {
              headers: { "User-Agent": "Sentio/1.0" },
            });
            if (compRes.ok) {
              const html = await compRes.text();
              const text = html
                .replace(/<script[\s\S]*?<\/script>/gi, "")
                .replace(/<style[\s\S]*?<\/style>/gi, "")
                .replace(/<[^>]+>/g, " ")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 3000);

              await supabase.from("external_data").insert({
                company_id,
                source: "competitor_site",
                data_type: "text",
                content: JSON.stringify({
                  competitor_name: comp.name,
                  url: comp.url,
                  text,
                }),
                expires_at: new Date(
                  Date.now() + 90 * 24 * 60 * 60 * 1000,
                ).toISOString(),
              });
            }
          } catch (e) {
            captureError(e as Error, {
              company_id,
              extra: { source: "competitor_site", competitor: comp.name },
            });
          }
        }
        results.competitor_site = "ok";
      }
    } catch (e) {
      captureError(e as Error, {
        company_id,
        extra: { source: "competitor_site" },
      });
      results.competitor_site = "error";
    }

    // 完了後にdetect-signalsをトリガー
    try {
      await fetch(
        `${Deno.env.get("SUPABASE_URL")}/functions/v1/detect-signals`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({ company_id }),
        },
      );
    } catch (e) {
      captureError(e as Error, {
        company_id,
        extra: { trigger: "detect-signals" },
      });
    }

    return new Response(JSON.stringify({ success: true, results }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    captureError(error as Error);
    return new Response(JSON.stringify({ error: "データ収集に失敗しました" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractKeywords(text: string): string[] {
  const keywords = [
    "安い",
    "高い",
    "遅い",
    "早い",
    "丁寧",
    "不満",
    "満足",
    "最悪",
    "最高",
    "対応",
    "サービス",
    "品質",
    "種類",
    "少ない",
    "多い",
    "改善",
    "悪い",
    "良い",
  ];
  return keywords.filter((k) => text.includes(k));
}
