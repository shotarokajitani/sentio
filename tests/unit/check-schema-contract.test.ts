import { describe, it, expect } from "vitest";
import { extractTableAccess } from "../../scripts/check-schema-contract";

/**
 * S-5-1: 各 Edge Function が読み書きする列集合を宣言的に取り出す部分のテスト。
 *
 * 実DBとの突合（information_schema.columns）は CI の integration ジョブで走る。
 * ここで固定するのは「**取り出しが取りこぼさない**」ことで、
 * 取り出しが漏れれば突合はいくらでも緑になる（検査の空洞）。
 */

function columns(src: string) {
  return extractTableAccess(src, "x.ts").accesses.map((a) => `${a.table}.${a.column}:${a.kind}`);
}

describe("extractTableAccess — 読み", () => {
  it("select の列を1つずつ取り出す", () => {
    const src = `await supabase.from("events").select("event_id, occurred_at, metrics");`;
    expect(columns(src)).toEqual([
      "events.event_id:read",
      "events.occurred_at:read",
      "events.metrics:read",
    ]);
  });

  it("フィルタ・並び替えの列も取り出す（select に出ない列で落ちる不具合を捕まえる）", () => {
    const src = `
      await supabase
        .from("baselines")
        .select("stats")
        .eq("company_id", id)
        .eq("is_established", true)
        .order("updated_at", { ascending: false })
        .limit(10);
    `;
    expect(columns(src)).toEqual([
      "baselines.stats:read",
      "baselines.company_id:filter",
      "baselines.is_established:filter",
      "baselines.updated_at:filter",
    ]);
  });

  it("in / is / contains / gte の列も取り出す", () => {
    const src = `
      await supabase
        .from("findings")
        .select("id")
        .in("status", ["open"])
        .is("company_id", null)
        .contains("evidence_event_ids", ids)
        .gte("created_at", cutoff);
    `;
    expect(columns(src)).toEqual([
      "findings.id:read",
      "findings.status:filter",
      "findings.company_id:filter",
      "findings.evidence_event_ids:filter",
      "findings.created_at:filter",
    ]);
  });

  it("or() の中の列名も取り出す", () => {
    const src = `await supabase.from("events").select("event_id").or("company_id.eq.1,company_id.is.null");`;
    expect(columns(src)).toContain("events.company_id:filter");
  });
});

describe("extractTableAccess — 書き", () => {
  it("insert のオブジェクトリテラルのキーを取り出す", () => {
    const src = `await supabase.from("baselines").insert({ company_id: id, metric_key: "revenue", stats: s });`;
    expect(columns(src)).toEqual([
      "baselines.company_id:write",
      "baselines.metric_key:write",
      "baselines.stats:write",
    ]);
  });

  it("upsert の onConflict に並ぶ列も取り出す（一意制約と噛み合わない不具合を捕まえる）", () => {
    const src = `
      await supabase.from("baselines").upsert(
        { company_id: id, metric_key: "revenue" },
        { onConflict: "company_id,metric_key,entity_id" },
      );
    `;
    expect(columns(src)).toEqual([
      "baselines.company_id:write",
      "baselines.metric_key:write",
      "baselines.company_id:conflict",
      "baselines.metric_key:conflict",
      "baselines.entity_id:conflict",
    ]);
  });

  it("ネストしたオブジェクトの内側のキーを列と誤認しない", () => {
    const src = `await supabase.from("findings").insert({ company_id: id, eval_log: { criteria: c, result: r } });`;
    expect(columns(src)).toEqual(["findings.company_id:write", "findings.eval_log:write"]);
  });

  it("update のキーも取り出す", () => {
    const src = `await supabase.from("narratives").update({ content: c, confidence: 1.0 }).eq("id", x);`;
    expect(columns(src)).toEqual([
      "narratives.content:write",
      "narratives.confidence:write",
      "narratives.id:filter",
    ]);
  });
});

describe("extractTableAccess — 検査できない箇所を黙って飛ばさない", () => {
  it("select('*') は違反として報告する", () => {
    const src = `await supabase.from("baselines").select("*").eq("company_id", id);`;
    const result = extractTableAccess(src, "x.ts");

    expect(result.starSelects).toHaveLength(1);
    expect(result.starSelects[0].table).toBe("baselines");
    // `*` を列として突合対象に混ぜない
    expect(result.accesses.map((a) => a.column)).not.toContain("*");
  });

  it("変数を渡す書き込みは「静的に検査できない」として一覧に出す", () => {
    const src = `await supabase.from("events").upsert(eventRows, { onConflict: "event_id" });`;
    const result = extractTableAccess(src, "x.ts");

    expect(result.unverifiableWrites).toHaveLength(1);
    expect(result.unverifiableWrites[0].table).toBe("events");
    // onConflict は静的に読めるので、そちらは取り出せている
    expect(result.accesses.map((a) => `${a.table}.${a.column}:${a.kind}`)).toEqual([
      "events.event_id:conflict",
    ]);
  });

  it("コメント内の .from() を拾わない", () => {
    const src = `// await supabase.from("events").select("nonexistent_column");`;
    expect(extractTableAccess(src, "x.ts").accesses).toEqual([]);
  });

  it("行番号が付く", () => {
    const src = `const a = 1;\nawait supabase.from("events").select("event_id");`;
    expect(extractTableAccess(src, "x.ts").accesses[0].line).toBe(2);
  });
});
