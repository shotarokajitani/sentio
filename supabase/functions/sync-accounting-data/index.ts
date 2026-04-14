import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { initSentry, captureError } from "../_shared/sentry.ts";
import { getServiceClient, corsHeaders } from "../_shared/supabase.ts";

initSentry("sync-accounting-data");

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ----- token helpers -----
async function ensureFreshToken(
  integ: any,
  provider: "freee" | "moneyforward",
) {
  if (!integ.token_expires_at) return integ;
  if (new Date(integ.token_expires_at).getTime() > Date.now() + 30_000)
    return integ;
  // call refresh endpoint
  const fn =
    provider === "freee" ? "freee-oauth/refresh" : "moneyforward-oauth/refresh";
  await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify({ company_id: integ.company_id }),
  });
  // re-fetch
  const supa = getServiceClient();
  const { data } = await supa
    .from("integrations")
    .select("*")
    .eq("id", integ.id)
    .single();
  return data ?? integ;
}

// ----- freee fetch & structure -----
async function freeeGet(token: string, urlPath: string) {
  const r = await fetch(`https://api.freee.co.jp${urlPath}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Api-Version": "2020-06-15",
    },
  });
  if (!r.ok) throw new Error(`freee ${urlPath} failed: ${r.status}`);
  return await r.json();
}

async function syncFreee(integ: any) {
  // 1) 会社一覧から最初の会社IDを取得（未指定なら）
  const companies = await freeeGet(integ.access_token, "/api/1/companies");
  const freeeCompanyId =
    integ.metadata?.freee_company_id ?? companies?.companies?.[0]?.id;
  if (!freeeCompanyId) throw new Error("no freee company");

  // 2) 月次PL（直近12ヶ月）
  const now = new Date();
  const fy = now.getFullYear();
  const trialPl = await freeeGet(
    integ.access_token,
    `/api/1/reports/trial_pl?company_id=${freeeCompanyId}&fiscal_year=${fy}&breakdown_display_type=group`,
  );

  // 3) 月次BS（キャッシュ系勘定）
  const trialBs = await freeeGet(
    integ.access_token,
    `/api/1/reports/trial_bs?company_id=${freeeCompanyId}&fiscal_year=${fy}`,
  );

  // 4) 取引先別売上（直近1年, 上位10）
  const startDate = new Date(now.getFullYear() - 1, now.getMonth(), 1)
    .toISOString()
    .slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);
  let topPartners: Array<{ partner_name: string; amount: number }> = [];
  try {
    const partnerReport = await freeeGet(
      integ.access_token,
      `/api/1/reports/trial_pl?company_id=${freeeCompanyId}&start_date=${startDate}&end_date=${endDate}&breakdown_display_type=partner`,
    );
    const balances = partnerReport?.trial_pl?.balances ?? [];
    topPartners = balances
      .filter((b: any) => b.partner_name)
      .map((b: any) => ({
        partner_name: b.partner_name,
        amount: Number(b.closing_balance ?? b.opening_balance ?? 0),
      }))
      .sort((a: any, b: any) => b.amount - a.amount)
      .slice(0, 10);
  } catch (_e) {
    // partner breakdownはプランにより未対応の場合がある
  }

  // 構造化（生データは保存しない）
  return {
    source: "freee",
    fiscal_year: fy,
    monthly_pl: extractFreeeMonthlyPl(trialPl),
    cashflow: extractFreeeCashflow(trialBs),
    top_partners: topPartners,
    fetched_at: new Date().toISOString(),
  };
}

function extractFreeeMonthlyPl(pl: any) {
  const balances: any[] = pl?.trial_pl?.balances ?? [];
  const pick = (account_category: string) => {
    const row = balances.find(
      (b) => b.account_category_name === account_category,
    );
    return row ? Number(row.closing_balance ?? 0) : 0;
  };
  const sales = pick("売上高");
  const cogs = pick("売上原価");
  const sgna = pick("販売管理費");
  return {
    sales,
    cogs,
    gross_profit: sales - cogs,
    operating_profit: sales - cogs - sgna,
  };
}

function extractFreeeCashflow(bs: any) {
  const balances: any[] = bs?.trial_bs?.balances ?? [];
  const cash = balances
    .filter((b) => /現金|預金/.test(b.account_item_name ?? ""))
    .reduce((sum, b) => sum + Number(b.closing_balance ?? 0), 0);
  return { cash_and_deposits: cash };
}

// ----- moneyforward fetch & structure -----
async function syncMoneyforward(integ: any) {
  // MF Cloud 会計のAPIエンドポイントは契約プロダクトに応じて変動するため、
  // 実際のエンドポイント名は梶谷さん側で確認のうえ調整してください。
  // ここでは想定エンドポイントで構造化のみ実施します。
  const headers = { Authorization: `Bearer ${integ.access_token}` };

  let monthlyPl: any = null;
  let cashflow: any = null;
  let accountBalances: any[] = [];

  try {
    const r = await fetch(
      "https://api.biz.moneyforward.com/api/v1/accounting/monthly_pl",
      { headers },
    );
    if (r.ok) monthlyPl = await r.json();
  } catch (_e) {}

  try {
    const r = await fetch(
      "https://api.biz.moneyforward.com/api/v1/accounting/cashflow",
      { headers },
    );
    if (r.ok) cashflow = await r.json();
  } catch (_e) {}

  try {
    const r = await fetch(
      "https://api.biz.moneyforward.com/api/v1/accounting/account_balances",
      { headers },
    );
    if (r.ok) {
      const j = await r.json();
      accountBalances = j?.account_balances ?? [];
    }
  } catch (_e) {}

  return {
    source: "moneyforward",
    monthly_pl: monthlyPl
      ? {
          sales: Number(monthlyPl.sales ?? 0),
          cogs: Number(monthlyPl.cogs ?? 0),
          gross_profit: Number(monthlyPl.gross_profit ?? 0),
          operating_profit: Number(monthlyPl.operating_profit ?? 0),
        }
      : null,
    cashflow: cashflow
      ? {
          operating: Number(cashflow.operating ?? 0),
          investing: Number(cashflow.investing ?? 0),
          financing: Number(cashflow.financing ?? 0),
        }
      : null,
    account_balances: accountBalances.map((a: any) => ({
      name: a.account_name ?? a.name,
      balance: Number(a.balance ?? 0),
    })),
    fetched_at: new Date().toISOString(),
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const { company_id, provider } = body as {
      company_id?: string;
      provider?: "freee" | "moneyforward";
    };
    if (!company_id) return jsonResp({ error: "company_id が必要です" }, 400);

    const supa = getServiceClient();
    const query = supa
      .from("integrations")
      .select("*")
      .eq("company_id", company_id)
      .in("status", ["connected"]);
    if (provider) query.eq("type", provider);
    const { data: integrations } = await query;

    if (!integrations || integrations.length === 0) {
      return jsonResp({ success: true, synced: 0, message: "連携なし" });
    }

    const results: any[] = [];
    for (const integ of integrations) {
      try {
        const fresh = await ensureFreshToken(integ, integ.type);
        const content =
          integ.type === "freee"
            ? await syncFreee(fresh)
            : await syncMoneyforward(fresh);

        const expiresAt = new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000,
        ).toISOString();

        await supa.from("external_data").insert({
          company_id,
          source_type: integ.type,
          content,
          expires_at: expiresAt,
        });

        await supa
          .from("integrations")
          .update({
            last_synced_at: new Date().toISOString(),
            status: "connected",
          })
          .eq("id", integ.id);

        results.push({ provider: integ.type, ok: true });
      } catch (e) {
        captureError(e as Error, {
          company_id,
          extra: { provider: integ.type },
        });
        await supa
          .from("integrations")
          .update({ status: "error" })
          .eq("id", integ.id);
        results.push({
          provider: integ.type,
          ok: false,
          error: (e as Error).message,
        });
      }
    }

    return jsonResp({
      success: true,
      synced: results.filter((r) => r.ok).length,
      results,
    });
  } catch (e) {
    captureError(e as Error);
    return jsonResp({ error: (e as Error).message }, 500);
  }
});
