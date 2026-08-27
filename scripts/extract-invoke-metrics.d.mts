/**
 * `extract-invoke-metrics.mjs` の型宣言。
 *
 * 実体を `.ts` ではなく `.mjs` で書いているのは、`invoke-function.yml` が
 * `pnpm install` を行わないため（S-4-10「このワークフローはデプロイを一切行わない」の
 * 最小構成を保つ）。tsx が無い環境で runner の node がそのまま実行できる必要がある。
 * その代わり型はここで与える。allowJs の推論に任せると `metrics` が `{}` に潰れて
 * テスト側が TS7053 になる。
 */

/** 抽出できた件数スカラー。キーは allowlist のパス（`finding_ids` は `.length` が付く）。 */
export type ExtractedMetrics = Record<string, number | boolean | null>;

/** allowlist に載っているが型が想定外だったキー。値は持たない（持たせない）。 */
export interface UnexpectedType {
  key: string;
  type: string;
}

export interface ExtractResult {
  /** 本文を JSON オブジェクトとして読めたか。読めなかったときに抽出0件へ丸めない */
  ok: boolean;
  reason?: "parse-failed" | "not-an-object";
  metrics: ExtractedMetrics;
  unexpectedTypes: UnexpectedType[];
  extractedCount: number;
  /** allowlist 外だったトップレベルのキーの数。名称は持たない */
  excludedCount: number;
}

export declare const METRIC_ALLOWLIST: readonly string[];
export declare const LENGTH_ALLOWLIST: readonly string[];

export declare function extractMetrics(text: string): ExtractResult;

/** run ログに載せる文字列を組み立てる。本文はここを通らない。 */
export declare function renderReport(result: ExtractResult): string;
