// parse-financial-csv
// ─────────────────────────────────────────────────────────────────────────────
// freee / マネーフォワード / 弥生 のエクスポートCSVから、
// 月次の { year_month, revenue, gross_profit, fixed_cost, operating_profit }
// を抽出する。
//
// セキュリティ要件：
//   - CSVファイル本体はサーバに保存しない（Storageに書かない／ログにも出さない）
//   - メモリ上でパース → 数値のみ financials テーブルへ保存
//   - レスポンス完了後にバッファは破棄される（GC）
//
// 動作モード：
//   - action = "preview"  : パースのみ。DBには書き込まない。画面プレビュー用。
//   - action = "commit"   : preview で返した rows を受け取り financials に upsert。
//
// フォーマット判定：
//   - CSVヘッダから自動判定
//   - 自動判定できない・明示指定したい場合は format パラメータで上書き
//     ("freee" | "mf" | "yayoi" | "generic")

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { initSentry, captureError } from "../_shared/sentry.ts";
import {
  getServiceClient,
  getUserClient,
  corsHeaders,
} from "../_shared/supabase.ts";

initSentry("parse-financial-csv");

type VendorFormat = "freee" | "mf" | "yayoi" | "generic";

interface FinancialRow {
  year_month: string; // 'YYYY-MM'
  revenue: number | null;
  gross_profit: number | null;
  fixed_cost: number | null;
  operating_profit: number | null;
}

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── CSVパーサ（軽量・引用符対応） ──────────────────────────────────────────
// RFC4180相当。ダブルクォート内のカンマ・改行も扱う。
function parseCsv(text: string): string[][] {
  // BOM除去
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (c === "\r") {
        // CRLFのCRは無視
      } else {
        field += c;
      }
    }
  }
  // 末尾のフィールド／行
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // CSVインジェクション対策: =, +, -, @, タブ, CR で始まるセルの先頭記号を除去。
  // このパーサが読んだ値はラベルマッチ・プレビューHTML表示・DB保存に使われる。
  // 将来的にユーザ入力由来の文字列を再度CSVへエクスポートする経路が追加されても、
  // 入口で式トリガを落としておくことで Excel/Numbers の式実行を防ぐ。
  const sanitized = rows.map((r) => r.map((cell) => stripFormulaPrefix(cell)));
  return sanitized.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function stripFormulaPrefix(cell: string): string {
  if (!cell) return cell;
  // CSVインジェクション: Excel/Numbersが先頭 =, +, -, @, TAB, NUL を数式として評価する。
  // - =, @, \t, \0 は常に先頭から落とす
  // - + は常に落とす（正符号付きの数値表記はCSV金額では出ない）
  // - - は「後ろが数字でない場合」のみ落とす（-1234 のような負数を壊さない）
  let out = cell.replace(/^[=@\t\r\u0000+]+/, "");
  if (/^-[^0-9]/.test(out)) {
    out = out.replace(/^-+/, "");
  }
  return out;
}

// 「1,234」「△1,234」「▲ 1,234」「(1,234)」「-1,234円」などを数値化
function parseAmount(s: string | undefined | null): number | null {
  if (s === undefined || s === null) return null;
  let str = String(s).trim();
  if (str === "" || str === "-" || str === "ー") return null;
  // 全角数字→半角
  str = str.replace(/[０-９]/g, (d) =>
    String.fromCharCode(d.charCodeAt(0) - 0xfee0),
  );
  // マイナス記号のバリエーション
  let negative = false;
  if (/^[△▲]/.test(str) || /^\(.+\)$/.test(str)) {
    negative = true;
    str = str.replace(/^[△▲]\s*/, "").replace(/^\((.+)\)$/, "$1");
  }
  // 余計な記号（¥, 円, カンマ, 空白）除去
  str = str.replace(/[¥￥,、\s円]/g, "");
  if (str.startsWith("-")) {
    negative = true;
    str = str.slice(1);
  }
  if (str === "" || !/^[0-9]+(\.[0-9]+)?$/.test(str)) return null;
  const n = Number(str);
  if (!isFinite(n)) return null;
  return Math.round(negative ? -n : n);
}

// 「2026/03」「2026-3」「2026年3月」「R8/3」などを 'YYYY-MM' に正規化
function normalizeYearMonth(s: string | undefined | null): string | null {
  if (!s) return null;
  const t = String(s)
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .trim();

  // 令和（R）→ 西暦。令和元年 = 2019
  const reiwa = t.match(/^R(?:eiwa)?\s*(\d{1,2})[\/\-年.](\d{1,2})月?/i);
  if (reiwa) {
    const y = 2018 + Number(reiwa[1]);
    const m = Number(reiwa[2]);
    if (m >= 1 && m <= 12) return `${y}-${String(m).padStart(2, "0")}`;
  }

  // 2026年3月 / 2026年03月
  const jp = t.match(/(\d{4})\s*年\s*(\d{1,2})\s*月?/);
  if (jp) {
    const m = Number(jp[2]);
    if (m >= 1 && m <= 12) return `${jp[1]}-${String(m).padStart(2, "0")}`;
  }

  // 2026/03, 2026-3, 2026.03
  const num = t.match(/(\d{4})[\/\-.](\d{1,2})/);
  if (num) {
    const m = Number(num[2]);
    if (m >= 1 && m <= 12) return `${num[1]}-${String(m).padStart(2, "0")}`;
  }

  return null;
}

// ─── フォーマット自動判定 ──────────────────────────────────────────────────
// freee  : 「売上高」「売上総利益」「販売費及び一般管理費」「営業利益」列を含む
// MF     : 「売上高」「粗利」「販管費」系 + 「月度」列
// 弥生   : 「勘定科目」「金額」列 + 月別縦持ち
// generic: 上記いずれにも当てはまらない場合は一般形式で試す
function detectFormat(rows: string[][]): VendorFormat {
  const flat = rows.flat().join("|");
  if (/freee/i.test(flat)) return "freee";
  if (/マネーフォワード|Money\s*Forward/i.test(flat)) return "mf";
  if (/弥生|Yayoi/i.test(flat)) return "yayoi";
  // ヘッダから推測
  const header = (rows.find((r) => r.length > 1) ?? []).join("|");
  if (/売上高.*売上総利益.*営業利益/.test(header)) return "freee";
  if (/(月度|年月).*売上.*(粗利|売上総利益).*営業利益/.test(header))
    return "mf";
  if (/勘定科目.*金額/.test(header)) return "yayoi";
  return "generic";
}

// ─── 勘定科目マッチング ────────────────────────────────────────────────────
const LABEL_MATCHERS: Record<keyof Omit<FinancialRow, "year_month">, RegExp> = {
  revenue: /^(売上高|売上高計|売上|純売上高|売上収益)$/,
  gross_profit: /^(売上総利益|粗利|売上総利益計)$/,
  fixed_cost:
    /^(販売費及び一般管理費|販売費及び一般管理費計|販管費|販売費|一般管理費)$/,
  operating_profit: /^(営業利益|営業損益|営業利益計)$/,
};

function matchLabel(
  label: string,
): keyof Omit<FinancialRow, "year_month"> | null {
  const trimmed = label.replace(/\s+/g, "").replace(/[（(].*?[)）]/g, "");
  for (const [key, re] of Object.entries(LABEL_MATCHERS)) {
    if (re.test(trimmed)) return key as keyof Omit<FinancialRow, "year_month">;
  }
  return null;
}

// ─── パース本体 ────────────────────────────────────────────────────────────
// 横持ち形式（1列＝1月、1行＝勘定科目）と縦持ち形式（1行＝月×科目）の両方を扱う。
function parseRows(rows: string[][], _format: VendorFormat): FinancialRow[] {
  if (rows.length === 0) return [];

  // 戦略A: 横持ち（freee/MFの標準エクスポート）
  //   ヘッダ行を探す → 「勘定科目」列 + 月ごとの列を特定
  const wide = tryParseWide(rows);
  if (wide.length > 0) return wide;

  // 戦略B: 縦持ち（弥生の月別試算表エクスポート）
  //   各行が { 年月, 勘定科目, 金額 } のような形
  const long = tryParseLong(rows);
  if (long.length > 0) return long;

  return [];
}

function tryParseWide(rows: string[][]): FinancialRow[] {
  // ヘッダ行検出：「勘定科目」や「項目」を含む行を探す
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const joined = rows[i].join("|");
    if (/勘定科目|項目|科目/.test(joined) && rows[i].length >= 2) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return [];

  const header = rows[headerIdx];
  // 月列を特定：列ヘッダが year_month として正規化できればOK
  const monthCols: { idx: number; ym: string }[] = [];
  for (let c = 0; c < header.length; c++) {
    const ym = normalizeYearMonth(header[c]);
    if (ym) monthCols.push({ idx: c, ym });
  }
  if (monthCols.length === 0) return [];

  // 月ごとの集計器
  const byMonth = new Map<string, FinancialRow>();
  for (const { ym } of monthCols) {
    byMonth.set(ym, {
      year_month: ym,
      revenue: null,
      gross_profit: null,
      fixed_cost: null,
      operating_profit: null,
    });
  }

  // 勘定科目列のインデックス（1列目にあることが多いが、先頭テキスト列を採用）
  let labelCol = 0;
  for (let c = 0; c < header.length; c++) {
    if (/勘定科目|項目|科目/.test(header[c])) {
      labelCol = c;
      break;
    }
  }

  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const label = row[labelCol] ?? "";
    const key = matchLabel(label);
    if (!key) continue;
    for (const { idx, ym } of monthCols) {
      const amt = parseAmount(row[idx]);
      if (amt === null) continue;
      const target = byMonth.get(ym)!;
      // 最初にマッチした値を採用（重複科目がある場合の暴発防止）
      if (target[key] === null) target[key] = amt;
    }
  }

  return Array.from(byMonth.values())
    .filter((r) => hasAnyNumber(r))
    .sort((a, b) => a.year_month.localeCompare(b.year_month));
}

function tryParseLong(rows: string[][]): FinancialRow[] {
  // ヘッダ行検出：「年月」「月度」＋「勘定科目」＋「金額」
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const joined = rows[i].join("|");
    if (
      (/年月|月度|対象月/.test(joined) || /期間/.test(joined)) &&
      /勘定科目|項目|科目/.test(joined) &&
      /金額|合計/.test(joined)
    ) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return [];

  const header = rows[headerIdx];
  const findCol = (re: RegExp) => header.findIndex((h) => re.test(h));
  const ymCol = findCol(/年月|月度|対象月|期間/);
  const labelCol = findCol(/勘定科目|項目|科目/);
  const amtCol = findCol(/金額|合計/);
  if (ymCol < 0 || labelCol < 0 || amtCol < 0) return [];

  const byMonth = new Map<string, FinancialRow>();
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const ym = normalizeYearMonth(row[ymCol]);
    if (!ym) continue;
    const key = matchLabel(row[labelCol] ?? "");
    if (!key) continue;
    const amt = parseAmount(row[amtCol]);
    if (amt === null) continue;
    if (!byMonth.has(ym)) {
      byMonth.set(ym, {
        year_month: ym,
        revenue: null,
        gross_profit: null,
        fixed_cost: null,
        operating_profit: null,
      });
    }
    const target = byMonth.get(ym)!;
    if (target[key] === null) target[key] = amt;
  }
  return Array.from(byMonth.values())
    .filter((r) => hasAnyNumber(r))
    .sort((a, b) => a.year_month.localeCompare(b.year_month));
}

function hasAnyNumber(r: FinancialRow): boolean {
  return (
    r.revenue !== null ||
    r.gross_profit !== null ||
    r.fixed_cost !== null ||
    r.operating_profit !== null
  );
}

// ─── 入力 rows の検証 ──────────────────────────────────────────────────────
function sanitizeCommitRows(input: unknown): FinancialRow[] {
  if (!Array.isArray(input)) return [];
  const out: FinancialRow[] = [];
  for (const r of input) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    const ym = typeof rec.year_month === "string" ? rec.year_month : "";
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) continue;
    const pickInt = (v: unknown): number | null => {
      if (v === null || v === undefined || v === "") return null;
      const n = Number(v);
      if (!isFinite(n)) return null;
      return Math.round(n);
    };
    const row: FinancialRow = {
      year_month: ym,
      revenue: pickInt(rec.revenue),
      gross_profit: pickInt(rec.gross_profit),
      fixed_cost: pickInt(rec.fixed_cost),
      operating_profit: pickInt(rec.operating_profit),
    };
    if (hasAnyNumber(row)) out.push(row);
  }
  return out;
}

// ─── エントリポイント ─────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResp({ error: "認証が必要です" }, 401);
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    const userClient = getUserClient(authHeader);
    const {
      data: { user },
      error: authErr,
    } = await userClient.auth.getUser(jwt);
    if (authErr || !user) return jsonResp({ error: "認証が必要です" }, 401);

    const contentType = req.headers.get("content-type") || "";

    // preview: multipart/form-data（ファイル付き）
    // commit : application/json（プレビューで返した rows を再送）
    let action = "preview";
    let companyId = "";
    let rows: FinancialRow[] = [];
    let detectedFormat: VendorFormat = "generic";

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      action = (form.get("action") as string) || "preview";
      companyId = (form.get("company_id") as string) || "";
      const file = form.get("file");
      const formatOverride = (form.get("format") as string) || "";

      if (!(file instanceof File))
        return jsonResp({ error: "file が必要です" }, 400);
      if (!companyId) return jsonResp({ error: "company_id が必要です" }, 400);

      // MIMEタイプ厳密化: text/csv のみ許可（ブラウザがCSV添付時に付ける標準値）。
      // 古いExcel経由で "application/vnd.ms-excel" が来るケースがあるが、
      // 要件に従い text/csv のみ受理する。
      if (file.type !== "text/csv") {
        return jsonResp(
          { error: "CSV形式（text/csv）のみアップロードできます" },
          400,
        );
      }

      // ファイルサイズ上限: 5MB（月次試算表12ヶ月分でも十分）。
      if (file.size > 5 * 1024 * 1024)
        return jsonResp({ error: "CSVファイルは5MB以下にしてください" }, 400);

      // CSVをメモリ上でテキスト化してパース。バイナリは保存しない。
      const buf = await file.arrayBuffer();
      // まずUTF-8で試し、文字化けしていたらShift_JISで再デコード
      let text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
      if (/\uFFFD/.test(text)) {
        try {
          text = new TextDecoder("shift_jis").decode(buf);
        } catch (_) {
          // shift_jis非対応環境なら fallback しない
        }
      }

      const csvRows = parseCsv(text);
      detectedFormat = (
        ["freee", "mf", "yayoi", "generic"] as VendorFormat[]
      ).includes(formatOverride as VendorFormat)
        ? (formatOverride as VendorFormat)
        : detectFormat(csvRows);
      rows = parseRows(csvRows, detectedFormat);
    } else {
      // JSON: commit 用
      const body = await req.json().catch(() => null);
      if (!body) return jsonResp({ error: "無効なリクエストです" }, 400);
      action = body.action || "commit";
      companyId = body.company_id || "";
      rows = sanitizeCommitRows(body.rows);
      if (!companyId) return jsonResp({ error: "company_id が必要です" }, 400);
    }

    // 所有権チェック（RLS下）
    const { data: company } = await userClient
      .from("companies")
      .select("id")
      .eq("id", companyId)
      .single();
    if (!company) return jsonResp({ error: "権限がありません" }, 403);

    if (action === "preview") {
      return jsonResp({
        success: true,
        detected_format: detectedFormat,
        rows,
        count: rows.length,
      });
    }

    if (action === "commit") {
      if (rows.length === 0)
        return jsonResp({ error: "保存するデータがありません" }, 400);
      const service = getServiceClient();
      const payload = rows.map((r) => ({
        company_id: companyId,
        year_month: r.year_month,
        revenue: r.revenue,
        gross_profit: r.gross_profit,
        fixed_cost: r.fixed_cost,
        operating_profit: r.operating_profit,
        source: "csv" as const,
      }));
      const { error: upErr, data: upData } = await service
        .from("financials")
        .upsert(payload, { onConflict: "company_id,year_month" })
        .select("id");
      if (upErr) {
        captureError(new Error(upErr.message), {
          company_id: companyId,
          extra: { stage: "commit_upsert" },
        });
        return jsonResp({ error: "保存に失敗しました" }, 500);
      }
      return jsonResp({
        success: true,
        saved: upData?.length ?? rows.length,
      });
    }

    return jsonResp({ error: "不明な action です" }, 400);
  } catch (e) {
    captureError(e as Error);
    return jsonResp({ error: (e as Error).message }, 500);
  }
});
