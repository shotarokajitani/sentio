import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { initSentry, captureError } from "../_shared/sentry.ts";
import { getServiceClient, corsHeaders } from "../_shared/supabase.ts";
import { startCronLog, finishCronLog } from "../_shared/cron-logger.ts";

initSentry("collect-external-data");

const GOOGLE_PLACES_API_KEY = Deno.env.get("GOOGLE_PLACES_API_KEY");
const ESTAT_API_KEY = Deno.env.get("ESTAT_API_KEY");
// e-Stat 経済センサス‐活動調査 デフォルトdataset（事業所数・従業者数 産業別×都道府県別）。
const ESTAT_STATS_DATA_ID = Deno.env.get("ESTAT_STATS_DATA_ID") ?? "0003411117";
const ESTAT_ENDPOINT =
  "https://api.e-stat.go.jp/rest/3.0/app/json/getStatsData";

// 国税庁 法人番号API（application id 必須）
const HOUJIN_BANGOU_APP_ID = Deno.env.get("HOUJIN_BANGOU_APP_ID");
// 日銀 統計データ検索API
const BOJ_STATS_ENDPOINT = "https://www.stat-search.boj.or.jp/api/";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = getServiceClient();
  const cronLog = await startCronLog(supabase, "collect-external-data");

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

    // D. 登記情報（国税庁法人番号公表サイトAPI v4）
    // 【3】設立年・所在地・業種コード等の構造化データを12ヶ月保存
    if (company.company_name && HOUJIN_BANGOU_APP_ID) {
      try {
        const name = encodeURIComponent(company.company_name);
        const regRes = await fetch(
          `https://api.houjin-bangou.nta.go.jp/4/name?id=${HOUJIN_BANGOU_APP_ID}&name=${name}&type=12&mode=2&kind=01`,
        );
        if (regRes.ok) {
          const regText = await regRes.text();
          const parsed = parseHoujinBangouCsv(regText);
          await supabase.from("external_data").insert({
            company_id,
            source: "corporate_registry",
            data_type: "json",
            content: JSON.stringify({
              sub_source: "houjin_bangou_nta",
              query: company.company_name,
              top_match: parsed[0] ?? null,
              candidates: parsed.slice(0, 3),
              fetched_at: new Date().toISOString(),
            }),
            expires_at: new Date(
              Date.now() + 365 * 24 * 60 * 60 * 1000,
            ).toISOString(),
          });
          results.corporate_registry = "ok";
        }
      } catch (e) {
        captureError(e as Error, {
          company_id,
          extra: { source: "corporate_registry" },
        });
        results.corporate_registry = "error";
      }
      await delay(1000);
    }

    // D2. Indeed / 求人ボックス RSS
    // 【8】会社名で求人検索。求人数と更新傾向を集計して 7日間保存。
    if (company.company_name) {
      try {
        const query = encodeURIComponent(company.company_name);
        const indeedUrl = `https://jp.indeed.com/rss?q=${query}&l=`;
        const kyujinBoxUrl = `https://xn--pckua2a7gp15o89zb.com/rss?q=${query}`;

        const [indeedRes, kbRes] = await Promise.all([
          fetch(indeedUrl, { headers: { "User-Agent": "Sentio/1.0" } }).catch(
            () => null,
          ),
          fetch(kyujinBoxUrl, {
            headers: { "User-Agent": "Sentio/1.0" },
          }).catch(() => null),
        ]);

        const summary: {
          indeed: RssStats;
          kyujin_box: RssStats;
        } = {
          indeed: await summarizeRss(indeedRes),
          kyujin_box: await summarizeRss(kbRes),
        };

        await supabase.from("external_data").insert({
          company_id,
          source: "job_posting",
          data_type: "json",
          content: JSON.stringify({
            sub_source: "rss",
            query: company.company_name,
            ...summary,
            fetched_at: new Date().toISOString(),
          }),
          // 求人の鮮度は短いので +7日
          expires_at: new Date(
            Date.now() + 7 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        });
        results.job_posting_rss = "ok";
      } catch (e) {
        captureError(e as Error, {
          company_id,
          extra: { source: "job_posting_rss" },
        });
        results.job_posting_rss = "error";
      }
      await delay(1000);
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

    // E3. 日銀短観API（業種別景況感）
    // 【4】業種別の景況感指数を取得。四半期更新のため +90日 キャッシュ。
    if (company.industry) {
      try {
        const bojSeriesCode = resolveBojTankanSeries(company.industry);
        if (bojSeriesCode) {
          const bojRes = await fetch(
            `${BOJ_STATS_ENDPOINT}?code=${encodeURIComponent(bojSeriesCode)}&format=json`,
            { headers: { "User-Agent": "Sentio/1.0" } },
          );
          if (bojRes.ok) {
            const raw = await bojRes.text();
            let parsedJson: unknown = null;
            try {
              parsedJson = JSON.parse(raw);
            } catch {
              // APIはCSV返却の場合があるため、生データをスライスして保存
              parsedJson = { raw: raw.slice(0, 3000) };
            }
            await supabase.from("external_data").insert({
              company_id,
              source: "boj_tankan",
              data_type: "json",
              content: JSON.stringify({
                series_code: bojSeriesCode,
                industry: company.industry,
                fetched_at: new Date().toISOString(),
                payload: parsedJson,
              }),
              // 四半期更新のため +90日
              expires_at: new Date(
                Date.now() + 90 * 24 * 60 * 60 * 1000,
              ).toISOString(),
            });
            results.boj_tankan = "ok";
          } else {
            console.error(
              "[collect-external-data] BOJ HTTP error:",
              bojRes.status,
            );
            results.boj_tankan = "error";
          }
        }
      } catch (e) {
        captureError(e as Error, {
          company_id,
          extra: { source: "boj_tankan" },
        });
        results.boj_tankan = "error";
      }
      await delay(1000);
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

    const okCount = Object.values(results).filter((v) => v === "ok").length;
    await finishCronLog(supabase, cronLog, {
      status: "success",
      recordsProcessed: okCount,
    });
    return new Response(JSON.stringify({ success: true, results }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    captureError(error as Error);
    await finishCronLog(supabase, cronLog, {
      status: "error",
      errorMessage: (error as Error).message,
    });
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

// 国税庁法人番号APIはCSV返却のため最低限のパース。
// フィールド：連番, 法人番号, 処理区分, 訂正区分, 更新日, 変更日, 商号, ..., 所在地, 所在地都道府県, 所在地市区町村, 設立日, ...
interface HoujinBangouRecord {
  corporate_number?: string;
  name?: string;
  prefecture?: string;
  city?: string;
  address?: string;
  established_on?: string;
}
function parseHoujinBangouCsv(csv: string): HoujinBangouRecord[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const records: HoujinBangouRecord[] = [];
  for (const line of lines.slice(0, 10)) {
    // CSVは引用符付き。簡易パース（カンマを引用符外でのみ分割）。
    const fields = parseCsvLine(line);
    if (fields.length < 10) continue;
    records.push({
      corporate_number: fields[1],
      name: fields[6],
      prefecture: fields[9],
      city: fields[10],
      address: fields[11],
      // 公開APIの設立日相当カラム（バージョンにより位置が変わる）
      established_on: fields[17] ?? fields[16] ?? undefined,
    });
  }
  return records;
}
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// RSS集計（タイトル数・初出日）
interface RssStats {
  fetched: boolean;
  count: number;
  latest_title?: string;
}
async function summarizeRss(res: Response | null): Promise<RssStats> {
  if (!res || !res.ok) return { fetched: false, count: 0 };
  const text = await res.text();
  const items = text.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  const firstTitle = items[0]?.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  return {
    fetched: true,
    count: items.length,
    latest_title: firstTitle.replace(/<!\[CDATA\[|\]\]>/g, "").slice(0, 120),
  };
}

// 日銀短観シリーズコード簡易マッピング。
// 業種テキストから短観の代表的なDIコード（業況判断DI, 全規模）へ解決。
// 本格対応には業種マスタが必要だが、MVPでは主要業種のみカバー。
function resolveBojTankanSeries(industry: string | null): string | null {
  if (!industry) return null;
  const t = industry;
  // 製造業
  if (/製造|メーカー|工場/.test(t)) return "CO'MA1SM@CPTK";
  if (/小売|物販|EC|eコマース/.test(t)) return "CO'MA1SS@CPTK";
  if (/卸|商社/.test(t)) return "CO'MA1SW@CPTK";
  if (/サービス|飲食|宿泊|観光/.test(t)) return "CO'MA1SV@CPTK";
  if (/建設|建築|土木/.test(t)) return "CO'MA1SC@CPTK";
  if (/不動産/.test(t)) return "CO'MA1SR@CPTK";
  if (/IT|情報|ソフト|SaaS|システム/.test(t)) return "CO'MA1SV@CPTK";
  return null;
}
