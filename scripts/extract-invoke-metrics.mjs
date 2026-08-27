/**
 * `invoke-function.yml` の 2xx 応答から、**件数スカラーだけ**を取り出す（契約 S-3-5）。
 *
 * ## なぜ要るのか
 *
 * 2026-08-20 に受入基準を訂正し、`invoke-function.yml` は 2xx の本文を
 * Actions のログに出さなくなった（バイト長と SHA-256 のみ）。理由は、成功応答が
 * 本番会社の活動データそのものだからである（`state-memory-packet` は実測で
 * `recent_events` を 824文字返した）。`--no-verify-jwt` を外して閉じた漏洩経路を、
 * Actions のログという別の場所に開き直すことになる。
 *
 * ところが S-3-5 の受入基準は「エラーなく完走し、**findings 0件**」であり、
 * その 0 が本文の中にしか無い。取得元とされた Supabase の Function Logs は
 * 検収者がダッシュボードを開けず（`docs/reports/2026-08-20_現状サマリ.md` §6）、
 * 実行側も本番 Ref への CLI 直接操作を禁じられている（CLAUDE.md 絶対規則）。
 * **双方から到達できない。**
 *
 * そこで訂正は保ったまま、件数だけを通す穴を開ける。
 *
 * ## なぜ allowlist なのか（除外リストにしない）
 *
 * `check:allowlist`（S-5-4）と同じ形にする。**出してよいキーを列挙し、それ以外は
 * 一切出さない。** 「本文っぽいものを除外する」形は、新しいキーが増えた瞬間に漏れる。
 * 実際 `scan` の応答には `immediates` / `candidates`、`deliver-pulse` には `pulse`
 * （メール本文の行）が載っており、いずれも予定タイトルを含む。
 * 除外リスト方式なら、次に足されるフィールドを誰かが登録し忘れた時点で漏れる。
 *
 * 3段の fail-closed で守る。
 *
 * 1. **キー**: allowlist に無いキーは値もキー名も出さない（除外件数だけ出す）
 * 2. **型**: allowlist にあっても number / boolean / null 以外は値を出さない。
 *    構造化された場合に中身が漏れない側へ倒す
 * 3. **深さ**: allowlist に書いた深さしか辿らない。深部を再帰的に探しに行かない
 */

import { pathToFileURL } from "node:url";

/** 値をそのまま出してよいキー。number / boolean / null のときに限る。 */
export const METRIC_ALLOWLIST = [
  // scan
  "total_candidates",
  "immediate_count",
  "investigation_count",
  // run-sense（scan の結果を入れ子で持つ）
  "scan.total_candidates",
  "scan.immediate_count",
  "scan.investigation_count",
  "immediates_inserted",
  "findings_from_investigator",
  "total_findings",
  // state-baselines
  "is_established",
  "observation_count",
  // state-summary
  "token_count",
  // deliver-*（本文 `pulse` は載せない。送ったか否かと試行回数だけ）
  "email_sent",
  "attempts",
];

/** 長さだけを出してよいキー。中身（ID 列）は出さない。 */
export const LENGTH_ALLOWLIST = ["finding_ids"];

/** number / boolean / null のみを件数スカラーとして認める。NaN と Infinity は弾く。 */
function isMetricScalar(value) {
  if (value === null) return true;
  if (typeof value === "boolean") return true;
  return typeof value === "number" && Number.isFinite(value);
}

/** 出力に使う型名。値そのものは決して含めない。 */
function typeNameOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** `a.b` を1段だけ辿る。allowlist に書いていない深さへは進まない。 */
function readPath(root, path) {
  const segments = path.split(".");
  let current = root;
  for (const segment of segments) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * 本文から件数スカラーを取り出す。
 *
 * 失敗（パース不能・オブジェクトでない）を「抽出0件」に丸めない。
 * 丸めると、本文が壊れているのか件数が本当に無いのかが区別できなくなる。
 */
export function extractMetrics(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      reason: "parse-failed",
      metrics: {},
      unexpectedTypes: [],
      extractedCount: 0,
      excludedCount: 0,
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: "not-an-object",
      metrics: {},
      unexpectedTypes: [],
      extractedCount: 0,
      excludedCount: 0,
    };
  }

  const metrics = {};
  const unexpectedTypes = [];
  /** 出力に使ったトップレベルのキー。除外件数を数えるために持つ */
  const consumedTopLevel = new Set();

  for (const path of METRIC_ALLOWLIST) {
    const value = readPath(parsed, path);
    if (value === undefined) continue;
    consumedTopLevel.add(path.split(".")[0]);

    if (isMetricScalar(value)) {
      metrics[path] = value;
    } else {
      // 静かに落とすと「0件だった」と誤読される。キー名と型だけ報告する（キーは既知＝安全）
      unexpectedTypes.push({ key: path, type: typeNameOf(value) });
    }
  }

  for (const key of LENGTH_ALLOWLIST) {
    const value = readPath(parsed, key);
    if (value === undefined) continue;
    consumedTopLevel.add(key.split(".")[0]);

    if (Array.isArray(value)) {
      metrics[`${key}.length`] = value.length;
    } else {
      unexpectedTypes.push({ key, type: typeNameOf(value) });
    }
  }

  const excludedCount = Object.keys(parsed).filter((k) => !consumedTopLevel.has(k)).length;

  return {
    ok: true,
    metrics,
    unexpectedTypes,
    extractedCount: Object.keys(metrics).length,
    excludedCount,
  };
}

/**
 * run ログに出す文字列を組み立てる。
 *
 * **この関数の出力だけが Actions のログに載る。** 入力の本文は決してここを通さない。
 */
export function renderReport(result) {
  const lines = ["--- 件数スカラー（allowlist 抽出。本文は出力しない） ---"];

  if (!result.ok) {
    lines.push(
      result.reason === "parse-failed"
        ? "本文を JSON として解釈できなかった。本文は出力しない"
        : "本文が JSON オブジェクトではなかった。本文は出力しない",
    );
    lines.push("--- ここまで ---");
    return lines.join("\n");
  }

  for (const [key, value] of Object.entries(result.metrics)) {
    lines.push(`${key}: ${value === null ? "null" : String(value)}`);
  }

  for (const { key, type } of result.unexpectedTypes) {
    lines.push(`${key}: <想定外の型 ${type}。値は出力しない>`);
  }

  if (result.extractedCount === 0) {
    lines.push("抽出できた件数スカラーは 0 件");
  }

  // 除外したキーは名前も出さない。件数だけで「取りこぼしが無いか」は判断できる
  lines.push(
    `--- ここまで（allowlist 外のキーは除外 ${result.excludedCount} 件・名称も非出力） ---`,
  );
  return lines.join("\n");
}

// CLI: node scripts/extract-invoke-metrics.mjs response.txt
// 直接実行されたときだけ走らせる（テストからの import では走らせない）。
// `file://${process.argv[1]}` の連結は Windows で一致しない（check-allowlist.ts:87 と同じ罠）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readFileSync } = await import("node:fs");
  const path = process.argv[2];
  if (!path) {
    console.error("usage: extract-invoke-metrics.mjs <response-file>");
    process.exit(2);
  }
  const result = extractMetrics(readFileSync(path, "utf8"));
  console.log(renderReport(result));
  // 抽出できなくても invoke 自体の成否（HTTP ステータス）は変えない。
  // ここで exit 1 にすると、件数スカラーを持たない関数の正常な 2xx まで赤くなる
}
