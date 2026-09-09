/**
 * `check:table-grants` の宣言側の突合を固定する（発注 ①-1.5）。
 *
 * **実DBに当たる部分（GRANT の照会・3本の実試行）はここでは見ない。**
 * それは CI の integration ジョブが実物で行う。ここが守るのは
 * 「宣言（`docs/checklists/table-grants.yml`）と migration 00038 の配列がずれない」形で、
 * **00036 が実際に落ちたのがこの穴**である——本文と GRANT は正しく、
 * 検証に使う一覧だけが古かった。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  compareDeclarationToMigration,
  loadDeclaration,
  migrationArrays,
} from "../../scripts/check-table-grants";

const root = path.resolve(__dirname, "../..");
const decl = loadDeclaration(path.join(root, "docs/checklists/table-grants.yml"));
const migration = readFileSync(
  path.join(root, "supabase/migrations/00038_revoke_write_grants.sql"),
  "utf8",
);

describe("宣言と migration の配列が一致する", () => {
  it("実物どうしで findings が0件（陽性コントロール）", () => {
    expect(compareDeclarationToMigration(decl, migration)).toEqual([]);
  });

  it("**陰性**: migration の配列から1表落とすと drift を吐く", () => {
    // 00036 で実際に起きた形。締める SQL は正しいのに、検証の一覧だけが足りない
    const broken = migration.replace("'connector_limits', 'delivery_log'", "'delivery_log'");
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
 */
describe("authenticated に残す書き込みを、許可側として宣言に持つ", () => {
  it("events / entities / connections の4権限が明記されている", () => {
    expect(decl.writable).toEqual(["connections", "entities", "events"]);
    expect(decl.writable_privileges).toEqual(["SELECT", "INSERT", "UPDATE", "DELETE"]);
  });

  it("**陰性**: 許可側が空なら、0件成功ではなく例外にする", () => {
    // **無い一覧を「一致した」と読ませない。** fail-closed
    const broken = readFileSync(
      path.join(root, "docs/checklists/table-grants.yml"),
      "utf8",
    ).replace(/^writable_privileges:\n(  - \w+\n)+/m, "writable_privileges: []\n");
    const tmp = path.join(root, "node_modules/.tmp-table-grants.yml");
    writeFileSync(tmp, broken);
    expect(() => loadDeclaration(tmp)).toThrow(/writable_privileges/);
    rmSync(tmp);
  });

  it("なぜ残すのかが宣言に書いてある（消すと本番の取り込みが止まる）", () => {
    const yml = readFileSync(path.join(root, "docs/checklists/table-grants.yml"), "utf8");
    expect(yml).toContain("createRouteClient");
    expect(yml).toContain("csv/ingest");
    expect(yml).toContain("connections/disconnect");
    expect(yml).toContain("competitors/suggest");
  });
});
