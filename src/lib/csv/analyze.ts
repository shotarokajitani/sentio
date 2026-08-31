/**
 * 列の対応推定の呼び出し口（契約 `docs/contracts/slice-csv-headerguard.md`・スライスCH）。
 *
 * このモジュールが持つ責任は1つだけ:
 * **1行目が列名の行でなければ、ネットワークに出ない。**
 *
 * 列名は `/api/csv/analyze` のプロンプトに `- "列名": 型=…` の形でそのまま載る。
 * 送ってしまえば取り消せない（CH-D8）。だから関門は `fetch` の**手前**に置く。
 * サーバ側にも同じ判定があるが、そちらは多層目である。サーバで弾く形だけにすると
 * 「列名は送られてから断られる」ことになり、塞いだことにならない（CH-D2）。
 *
 * コンポーネント（`connect-client.tsx`）ではなくモジュールに置いてあるのは、
 * DOM を起こさずに「**呼ばれないこと**」を試験できるようにするためである
 * （`tests/unit/csv-analyze-guard.test.ts`。`lib/connections/disconnect.ts` と同じ形）。
 *
 * **既存の経路は作り替えていない。** 送る本文も、応答の扱いも今までのままで、
 * 足したのは `no_header_row` の1本だけである。
 */
import { inspectHeaderRow, type HeaderRowVerdict } from "@shared/csv/header-guard";

/** 列の対応推定 API の場所 */
export const CSV_ANALYZE_ENDPOINT = "/api/csv/analyze";

/** Sentio のスキーマへの対応表。`null` は「その項目に当たる列が無い」 */
export interface ColumnMapping {
  date: string;
  description: string | null;
  amount: string | null;
  direction: string | null;
  credit: string | null;
  debit: string | null;
  balance: string | null;
}

/** 列ごとの型統計。文字列列はPIIを含みうるので `samples` を持たない */
export interface CsvTypeStat {
  type: string;
  digits: number | null;
  sample_count: number;
  samples?: string[];
}

export type ColumnMappingOutcome =
  | { ok: true; mapping: ColumnMapping }
  /** 1行目が列名の行ではなかった。**API は呼んでいない** */
  | { ok: false; reason: "no_header_row"; verdict: HeaderRowVerdict }
  /** それ以外の失敗。原因は画面では切り分けない（別スライス） */
  | { ok: false; reason: "failed"; status: number | null };

export async function requestColumnMapping(input: {
  headers: string[];
  rowCount: number;
  typeStats: Record<string, CsvTypeStat>;
  fetchImpl?: typeof fetch;
}): Promise<ColumnMappingOutcome> {
  // ここが唯一の関門。**通らなければネットワークに出ない**（受入基準 CH-1-2）
  const verdict = inspectHeaderRow(input.headers);
  if (!verdict.isHeader) {
    return { ok: false, reason: "no_header_row", verdict };
  }

  const doFetch = input.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch(CSV_ANALYZE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        headers: input.headers,
        row_count: input.rowCount,
        type_stats: input.typeStats,
      }),
    });
  } catch {
    return { ok: false, reason: "failed", status: null };
  }

  if (!res.ok) {
    return { ok: false, reason: "failed", status: res.status };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  const mapping = (body as { mapping?: ColumnMapping } | null)?.mapping;
  if (!mapping) {
    return { ok: false, reason: "failed", status: res.status };
  }

  return { ok: true, mapping };
}
