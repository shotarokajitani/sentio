/**
 * `check:table-grants` の宣言側の突合を固定する（発注 ①-1.5）。
 *
 * **実DBに当たる部分（GRANT の照会・3本の実試行）はここでは見ない。**
 * それは CI の integration ジョブが実物で行う。ここが守るのは
 * 「宣言（`docs/checklists/table-grants.yml`）と migration の配列がずれない」形で、
 * （配列を持つ migration は 00038 → 00050。2026-09-13 の点検・PR-2b）
 * **00036 が実際に落ちたのがこの穴**である——本文と GRANT は正しく、
 * 検証に使う一覧だけが古かった。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  MIGRATION,
  compareDeclarationToLive,
  compareDeclarationToMigration,
  loadDeclaration,
  migrationArrays,
} from "../../scripts/check-table-grants";

const root = path.resolve(__dirname, "../..");
const decl = loadDeclaration(path.join(root, "docs/checklists/table-grants.yml"));
const migration = readFileSync(path.join(root, MIGRATION), "utf8");

describe("宣言と migration の配列が一致する", () => {
  it("実物どうしで findings が0件（陽性コントロール）", () => {
    expect(compareDeclarationToMigration(decl, migration)).toEqual([]);
  });

  it("**陰性**: migration の配列から1表落とすと drift を吐く", () => {
    // 00036 で実際に起きた形。締める SQL は正しいのに、検証の一覧だけが足りない
    const broken = migration.replace(" 'connector_limits',", "");
    expect(broken).not.toBe(migration);
    const findings = compareDeclarationToMigration(decl, broken);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("read_only");
    expect(findings[0]).toContain("[drift]");
  });

  it("**陰性**: TRUNCATE を never の配列から外すと drift を吐く", () => {
    const broken = migration.replace(
      "ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER']",
      "ARRAY['REFERENCES', 'TRIGGER']",
    );
    expect(broken).not.toBe(migration);
    expect(compareDeclarationToMigration(decl, broken)[0]).toContain("never_granted");
  });

  it("**陰性**: no_access の配列から1表落とすと drift を吐く", () => {
    const broken = migration.replace("'api_rate_limits', ", "");
    expect(broken).not.toBe(migration);
    const findings = compareDeclarationToMigration(decl, broken);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("no_access");
  });

  it("**陰性**: migration の writable に表を戻すと drift を吐く（書き込みを残す約束が宣言と食い違う）", () => {
    const broken = migration.replace(
      "writable   TEXT[] := ARRAY[]::TEXT[];",
      "writable   TEXT[] := ARRAY['events'];",
    );
    expect(broken).not.toBe(migration);
    expect(compareDeclarationToMigration(decl, broken)[0]).toContain("writable");
  });

  it("**陰性**: 配列そのものが消えたら、0件成功ではなく例外にする", () => {
    // **無い一覧を「一致した」と読ませない。** fail-closed
    const broken = migration.replace(
      /writable\s+TEXT\[\]\s*:=\s*ARRAY\[[^\]]*\]/,
      "writable TEXT[] := '{}'",
    );
    expect(broken).not.toBe(migration);
    expect(() => migrationArrays(broken)).toThrow(/writable/);
  });
});

describe("宣言の中身", () => {
  it("TRUNCATE / REFERENCES / TRIGGER はどの表にも渡さない", () => {
    expect(decl.never_granted).toEqual(["TRUNCATE", "REFERENCES", "TRIGGER"]);
  });

  it("読むだけの表と書き込みのある表が重ならない", () => {
    const overlap = decl.read_only.filter((t) => decl.writable.includes(t));
    expect(overlap).toEqual([]);
  });

  it("00036 の実装漏れ2表が、読むだけの側に入っている", () => {
    expect(decl.read_only).toContain("connector_limits");
    expect(decl.read_only).toContain("known_explanations");
  });
});

/**
 * 許可側（`writable_privileges`）を宣言に持つ（2026-09-10 の発注 5）。
 *
 * **「残す約束」も宣言に書く。** 検査器の中に配列を書くと、
 * 宣言と実装の2か所を人が書き写すことになり、00036 と同じずれ方をする。
 *
 * 2026-09-13 の点検・PR-2b（00050）で、書き込みを残す表は0表になった。
 */
describe("authenticated に書き込みを残す表は無い（PR-2b）", () => {
  it("writable は空で、events / entities / connections は読むだけの側にある", () => {
    expect(decl.writable).toEqual([]);
    for (const t of ["connections", "entities", "events"]) expect(decl.read_only).toContain(t);
    expect(decl.writable_privileges).toEqual(["SELECT", "INSERT", "UPDATE", "DELETE"]);
  });

  it("**陰性**: writable のキーが消えたら、空とは読まず例外にする", () => {
    const original = readFileSync(path.join(root, "docs/checklists/table-grants.yml"), "utf8");
    const broken = original.replace(/^writable: \[\]\r?\n/m, "");
    expect(broken, "置換が空振りしている").not.toBe(original);
    const tmp = path.join(root, "node_modules/.tmp-table-grants-writable.yml");
    writeFileSync(tmp, broken);
    expect(() => loadDeclaration(tmp)).toThrow(/writable が無い/);
    rmSync(tmp);
  });

  it("**陰性**: 許可側が空なら、0件成功ではなく例外にする", () => {
    // **無い一覧を「一致した」と読ませない。** fail-closed
    // **改行に依存させない。** `\n` 固定にすると、CRLF でチェックアウトされた環境で
    // 置換が空振りし、**壊していないのに緑になる**（2026-09-10 に Windows で実測）
    const original = readFileSync(path.join(root, "docs/checklists/table-grants.yml"), "utf8");
    const broken = original.replace(
      /^writable_privileges:\r?\n(\s+-\s+\w+\r?\n)+/m,
      "writable_privileges: []\n",
    );
    expect(broken, "置換が空振りしている").not.toBe(original);
    const tmp = path.join(root, "node_modules/.tmp-table-grants.yml");
    writeFileSync(tmp, broken);
    expect(() => loadDeclaration(tmp)).toThrow(/writable_privileges/);
    rmSync(tmp);
  });

  it("なぜ外せたのかが宣言に書いてある（経路を service_role に寄せてから外した）", () => {
    const yml = readFileSync(path.join(root, "docs/checklists/table-grants.yml"), "utf8");
    expect(yml).toContain("service_role");
    expect(yml).toContain("csv/ingest");
    expect(yml).toContain("connections/disconnect");
    expect(yml).toContain("competitors/suggest");
  });
});

/**
 * 何も渡さない表（`no_access`・2026-09-13 の点検・PR-2b）。
 *
 * 実DBの GRANT は CI の integration ジョブが引く。ここは**引いた結果の読み方**を固定する。
 */
describe("何も渡さない表の突合", () => {
  /** 宣言どおりの GRANT を組み立てる（read_only は SELECT だけ、no_access は何も無し） */
  function grantsAsDeclared(): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>();
    for (const t of decl.read_only) map.set(`authenticated:${t}`, new Set(["SELECT"]));
    return map;
  }

  it("api_rate_limits と RLS 有効・ポリシー無しの既存5表が宣言に入っている", () => {
    expect(decl.no_access).toEqual([
      "api_rate_limits",
      "billing_webhook_events",
      "billing_webhook_unresolved",
      "connection_events",
      "dispatch_runs",
      "retention_purge_runs",
    ]);
  });

  it("宣言どおりなら findings は0件（陽性コントロール）", () => {
    expect(compareDeclarationToLive(decl, grantsAsDeclared())).toEqual([]);
  });

  it("**陰性**: authenticated が api_rate_limits に SELECT を持っていたら extra を吐く", () => {
    const grants = grantsAsDeclared();
    grants.set("authenticated:api_rate_limits", new Set(["SELECT"]));
    const findings = compareDeclarationToLive(decl, grants);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("api_rate_limits");
    expect(findings[0]).toContain("何も渡さない表");
  });

  it("**陰性**: anon が dispatch_runs に何か持っていても extra を吐く", () => {
    const grants = grantsAsDeclared();
    grants.set("anon:dispatch_runs", new Set(["INSERT"]));
    expect(compareDeclarationToLive(decl, grants)[0]).toContain("anon が dispatch_runs");
  });

  it("**陰性**: events に INSERT が残っていたら extra を吐く（PR-2b の本体）", () => {
    const grants = grantsAsDeclared();
    grants.set("authenticated:events", new Set(["SELECT", "INSERT"]));
    expect(compareDeclarationToLive(decl, grants)).toEqual([
      "[extra] authenticated が events に INSERT を持っている（読むだけの表）",
    ]);
  });
});
