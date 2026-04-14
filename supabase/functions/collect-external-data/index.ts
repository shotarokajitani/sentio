import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { initSentry, captureError } from "../_shared/sentry.ts";
import { getServiceClient, corsHeaders } from "../_shared/supabase.ts";

initSentry("collect-external-data");

const GOOGLE_PLACES_API_KEY = Deno.env.get("GOOGLE_PLACES_API_KEY");
const ESTAT_API_KEY = Deno.env.get("ESTAT_API_KEY");
// e-Stat 経済センサス‐活動調査 デフォルトdataset（事業所数・従業者数 産業別×都道府県別）。
// 年度更新で変わる可能性があるため、環境変数 ESTAT_STATS_DATA_ID で上書き可能。
const ESTAT_STATS_DATA_ID = Deno.env.get("ESTAT_STATS_DATA_ID") ?? "0003411117";
const ESTAT_ENDPOINT =
  "https://api.e-stat.go.jp/rest/3.0/app/json/getStatsData";

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

    // E2. e-Stat API（経済センサス: 業種別企業数 / 都道府県別事業所数）
    // industry または prefecture が判明していて、APIキーがある場合のみ取得する。
    if (ESTAT_API_KEY && (company.industry || company.prefecture)) {
      try {
        const params = new URLSearchParams({
          appId: ESTAT_API_KEY,
          statsDataId: ESTAT_STATS_DATA_ID,
          limit: "100",
          lang: "J",
        });

        // 所在地（都道府県）が分かっていれば地域コードで絞り込み
        const prefCode = prefectureToCode(company.prefecture);
        if (prefCode) params.set("cdArea", prefCode);

        const estatRes = await fetch(`${ESTAT_ENDPOINT}?${params.toString()}`);

        if (estatRes.ok) {
          const estatJson = (await estatRes.json()) as EStatResponse;
          const status = estatJson?.GET_STATS_DATA?.RESULT?.STATUS;
          const errMsg = estatJson?.GET_STATS_DATA?.RESULT?.ERROR_MSG;

          if (status === 0) {
            const values =
              estatJson?.GET_STATS_DATA?.STATISTICAL_DATA?.DATA_INF?.VALUE ??
              [];
            const valuesArr = Array.isArray(values) ? values : [values];

            // レビューテキスト同様、生データは必要分だけ保存する（サイズ制限）
            await supabase.from("external_data").insert({
              company_id,
              source: "industry_stats",
              data_type: "json",
              content: JSON.stringify({
                sub_source: "estat",
                stats_data_id: ESTAT_STATS_DATA_ID,
                industry: company.industry ?? null,
                prefecture: company.prefecture ?? null,
                pref_code: prefCode,
                fetched_at: new Date().toISOString(),
                values_count: valuesArr.length,
                values: valuesArr.slice(0, 100),
              }),
              // 経済センサスは年次更新のため 90日（3ヶ月）で再取得
              expires_at: new Date(
                Date.now() + 90 * 24 * 60 * 60 * 1000,
              ).toISOString(),
            });
            results.industry_stats_estat = "ok";
          } else {
            console.error(
              "[collect-external-data] e-Stat API error:",
              status,
              errMsg,
            );
            results.industry_stats_estat = "error";
          }
        } else {
          console.error(
            "[collect-external-data] e-Stat HTTP error:",
            estatRes.status,
          );
          results.industry_stats_estat = "error";
        }
      } catch (e) {
        captureError(e as Error, {
          company_id,
          extra: { source: "industry_stats_estat" },
        });
        results.industry_stats_estat = "error";
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

// e-Stat APIレスポンス型（必要部分のみ）
interface EStatResponse {
  GET_STATS_DATA?: {
    RESULT?: { STATUS?: number; ERROR_MSG?: string };
    STATISTICAL_DATA?: {
      DATA_INF?: { VALUE?: unknown };
    };
  };
}

// 都道府県名 → e-Stat地域コード（2桁）マッピング。
// e-Statの地域コードは総務省準拠の2桁数字（JIS X 0401）。
// 住所文字列の先頭に含まれるパターンにもマッチできるよう前方一致で検索する。
const PREFECTURE_CODES: Record<string, string> = {
  北海道: "01",
  青森県: "02",
  岩手県: "03",
  宮城県: "04",
  秋田県: "05",
  山形県: "06",
  福島県: "07",
  茨城県: "08",
  栃木県: "09",
  群馬県: "10",
  埼玉県: "11",
  千葉県: "12",
  東京都: "13",
  神奈川県: "14",
  新潟県: "15",
  富山県: "16",
  石川県: "17",
  福井県: "18",
  山梨県: "19",
  長野県: "20",
  岐阜県: "21",
  静岡県: "22",
  愛知県: "23",
  三重県: "24",
  滋賀県: "25",
  京都府: "26",
  大阪府: "27",
  兵庫県: "28",
  奈良県: "29",
  和歌山県: "30",
  鳥取県: "31",
  島根県: "32",
  岡山県: "33",
  広島県: "34",
  山口県: "35",
  徳島県: "36",
  香川県: "37",
  愛媛県: "38",
  高知県: "39",
  福岡県: "40",
  佐賀県: "41",
  長崎県: "42",
  熊本県: "43",
  大分県: "44",
  宮崎県: "45",
  鹿児島県: "46",
  沖縄県: "47",
};

function prefectureToCode(pref: string | null | undefined): string | null {
  if (!pref) return null;
  const trimmed = pref.trim();
  if (PREFECTURE_CODES[trimmed]) return PREFECTURE_CODES[trimmed];
  // 住所文字列先頭に都道府県名が含まれるケースに対応（例: "東京都渋谷区..."）
  for (const [name, code] of Object.entries(PREFECTURE_CODES)) {
    if (trimmed.startsWith(name)) return code;
  }
  return null;
}
