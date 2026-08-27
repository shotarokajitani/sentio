import { describe, it, expect } from "vitest";
import {
  extractMetrics,
  renderReport,
  METRIC_ALLOWLIST,
  LENGTH_ALLOWLIST,
} from "../../scripts/extract-invoke-metrics.mjs";

/**
 * `invoke-function.yml` が 2xx 本文から件数スカラーだけを取り出すときの
 * 陽性・陰性コントロール（契約 S-3-5 の証跡経路）。
 *
 * 2026-08-20 の受入基準訂正は「2xx の本文を Actions のログに出さない」であり、
 * その理由は成功応答が本番会社の活動データそのものだからである。
 * ここで足すのは**訂正の例外**ではなく、訂正を保ったまま件数だけを通す穴である。
 * したがって形は `check:allowlist`（S-5-4）と同じ **fail-closed** にする。
 * 「出してよいキーを列挙し、それ以外は一切出さない」。
 * 「本文っぽいものを除外する」形にすると、新しいキーが増えた瞬間に漏れる。
 */

/** 本番の `scan` が実際に返す形（supabase/functions/scan/index.ts:217-225）。 */
const SCAN_RESPONSE = JSON.stringify({
  status: "ok",
  company_id: "197f2c0e-aef8-405d-afcc-34d23c771fcd",
  total_candidates: 0,
  immediate_count: 0,
  investigation_count: 0,
  immediates: [],
  candidates: [],
});

/** 本番の `run-sense` が実際に返す形（supabase/functions/run-sense/index.ts:159-171）。 */
const RUN_SENSE_RESPONSE = JSON.stringify({
  status: "ok",
  company_id: "197f2c0e-aef8-405d-afcc-34d23c771fcd",
  scan: { total_candidates: 0, immediate_count: 0, investigation_count: 0 },
  immediates_inserted: 0,
  findings_from_investigator: 0,
  total_findings: 0,
  finding_ids: [],
});

describe("METRIC_ALLOWLIST（何を出してよいかの定義そのもの）", () => {
  it("列挙されたキーだけが許可対象であり、本文型のキーを含まない", () => {
    // 顧客データ本体のキーが allowlist に紛れ込んでいないことを、定義側でも固定する
    for (const forbidden of ["immediates", "candidates", "pulse", "lines", "recent_events"]) {
      expect(METRIC_ALLOWLIST).not.toContain(forbidden);
      expect(LENGTH_ALLOWLIST).not.toContain(forbidden);
    }
  });
});

describe("extractMetrics — 陽性（出してよいものが出る）", () => {
  it("scan の件数スカラーを取り出す", () => {
    const r = extractMetrics(SCAN_RESPONSE);
    expect(r.ok).toBe(true);
    expect(r.metrics).toEqual({
      total_candidates: 0,
      immediate_count: 0,
      investigation_count: 0,
    });
  });

  it("run-sense の総件数と、ネストした scan.* を取り出す", () => {
    const r = extractMetrics(RUN_SENSE_RESPONSE);
    expect(r.ok).toBe(true);
    expect(r.metrics["total_findings"]).toBe(0);
    expect(r.metrics["scan.total_candidates"]).toBe(0);
    expect(r.metrics["immediates_inserted"]).toBe(0);
  });

  it("配列は長さだけを出し、中身は出さない", () => {
    const body = JSON.stringify({
      total_findings: 2,
      finding_ids: ["8f14e45f-ceea-467a-9e6f-1b2c3d4e5f60", "3c59dc04-8e88-4a5d-9c1e-2f3a4b5c6d7e"],
    });
    const r = extractMetrics(body);
    expect(r.metrics["finding_ids.length"]).toBe(2);
    // ID そのものは出力のどこにも現れない
    expect(renderReport(r)).not.toContain("8f14e45f");
  });

  it("boolean と null も件数系として扱う（email_sent は3値を取る）", () => {
    expect(extractMetrics(JSON.stringify({ email_sent: true })).metrics["email_sent"]).toBe(true);
    expect(extractMetrics(JSON.stringify({ email_sent: null })).metrics["email_sent"]).toBe(null);
    expect(
      extractMetrics(JSON.stringify({ is_established: false })).metrics["is_established"],
    ).toBe(false);
  });
});

describe("extractMetrics — 陰性（allowlist に無いものは一切出ない）", () => {
  /**
   * ここが本題である。**予定タイトルは本番会社の活動データそのもの。**
   * `scan` の `candidates` / `immediates`、`deliver-pulse` の `pulse` に実際に載る。
   */
  const LEAKY_RESPONSE = JSON.stringify({
    status: "ok",
    company_id: "197f2c0e-aef8-405d-afcc-34d23c771fcd",
    total_candidates: 1,
    immediate_count: 0,
    // 以下はすべて allowlist に無い。1文字も出てはならない
    candidates: [
      { what: "山田商事 定例MTG 見積提出", entity_ref: "yamada-shoji", severity: "high" },
    ],
    immediates: [{ what: "サイト死活 監視断" }],
    pulse: ["2026-08-26: 15件のイベントを記録", "主な種別: schedule", "状態: 平常"],
    recent_events: "取締役会 資金繰り 銀行折衝",
  });

  it("allowlist に無いキーの値が、抽出結果にもレポートにも現れない", () => {
    const r = extractMetrics(LEAKY_RESPONSE);
    const report = renderReport(r);

    for (const secret of [
      "山田商事",
      "定例MTG",
      "見積提出",
      "yamada-shoji",
      "サイト死活",
      "取締役会",
      "資金繰り",
      "銀行折衝",
      "schedule",
      "197f2c0e",
    ]) {
      expect(report).not.toContain(secret);
      expect(JSON.stringify(r.metrics)).not.toContain(secret);
    }
  });

  it("allowlist に無いキーは、キー名すらレポートに出さない（件数だけを出す）", () => {
    const r = extractMetrics(LEAKY_RESPONSE);
    const report = renderReport(r);

    // 部分文字列で照合すると `total_candidates` が `candidates` に誤ヒットする。
    // レポートに現れるキー名を行から取り出し、**集合として** allowlist 内であることを見る
    const reportedKeys = report
      .split("\n")
      .filter((line) => !line.startsWith("---"))
      .map((line) => line.split(":")[0]);

    expect(reportedKeys).toEqual(["total_candidates", "immediate_count"]);
    for (const key of ["candidates", "immediates", "pulse", "recent_events", "company_id"]) {
      expect(reportedKeys).not.toContain(key);
    }

    // 黙って捨てるのではなく、除外した件数は見えるようにする。
    // 除外は status / company_id / candidates / immediates / pulse / recent_events の6件
    expect(r.excludedCount).toBe(6);
    expect(report).toContain("除外 6 件");
  });

  it("allowlist に載っていても、値が件数型でなければ値を出さない", () => {
    // 将来 total_findings が構造化されても、中身が漏れない側に倒す
    const r = extractMetrics(
      JSON.stringify({ total_findings: { count: 3, what: "山田商事との取引減" } }),
    );
    const report = renderReport(r);

    expect(report).not.toContain("山田商事");
    expect(r.metrics["total_findings"]).toBeUndefined();
    // 欠落が静かに起きないよう、キー名と型だけは報告する（キーは既知＝安全）
    expect(r.unexpectedTypes).toEqual([{ key: "total_findings", type: "object" }]);
    expect(report).toContain("total_findings: <想定外の型 object。値は出力しない>");
  });

  it("allowlist に無いキーが新しく増えても、既定で出ない", () => {
    // 「本文っぽいものを除外する」形なら漏れるケース。allowlist 方式なら既定で塞がる
    const r = extractMetrics(
      JSON.stringify({ total_findings: 0, summary_text: "全社の資金繰りが悪化している" }),
    );
    expect(renderReport(r)).not.toContain("資金繰り");
    expect(r.excludedCount).toBe(1);
  });
});

describe("extractMetrics — fail-closed（読めないときに本文へ倒れない）", () => {
  it("JSON として読めない本文は、抽出失敗として扱い本文を出さない", () => {
    const r = extractMetrics("<html>500 Internal Server Error 山田商事</html>");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("parse-failed");
    expect(renderReport(r)).not.toContain("山田商事");
    expect(renderReport(r)).toContain("本文を JSON として解釈できなかった");
  });

  it("JSON だがオブジェクトでない本文も、抽出失敗として扱う", () => {
    const r = extractMetrics(JSON.stringify(["山田商事 定例MTG"]));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("not-an-object");
    expect(renderReport(r)).not.toContain("山田商事");
  });

  it("allowlist のキーが1件も無い応答は、静かに空にせず明示する", () => {
    const r = extractMetrics(JSON.stringify({ status: "ok" }));
    expect(r.ok).toBe(true);
    expect(r.extractedCount).toBe(0);
    expect(renderReport(r)).toContain("抽出できた件数スカラーは 0 件");
  });

  it("ネストは allowlist に書いた深さしか辿らない（深部の本文を拾わない）", () => {
    const r = extractMetrics(
      JSON.stringify({ scan: { total_candidates: 0, candidates: [{ what: "山田商事" }] } }),
    );
    expect(r.metrics["scan.total_candidates"]).toBe(0);
    expect(renderReport(r)).not.toContain("山田商事");
  });
});
