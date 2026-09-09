/// <reference types="node" />

/**
 * `authenticated` / `anon` の表権限を、宣言・migration・実DB の4方向で突き合わせる
 * （発注 ①-1.5）。
 *
 * ## なぜ4方向か
 *
 * 00036 は **本文と GRANT は正しく、REVOKE の相手と自表検証の一覧だけがずれていた。**
 * 「migration が緑になったか」では捕まらない形なので、
 * `check:ci-coverage` と同じ作法で **宣言 × 実物** の写像として見る。
 *
 *   1. 宣言（`docs/checklists/table-grants.yml`） × migration 00038 の配列
 *   2. 宣言 × 実DBの `information_schema.role_table_grants`
 *   3. 実DBで **実際に叩いて** 42501 で断られること（`scripts/probe-table-grants.ts`）
 *   4. その 42501 が **GRANT の層**であること（`permission denied for table`）
 *
 * 3 が要るのは、GRANT の一覧が「最終的に何が通るか」を見せないためである。
 * RLS と合わせた結果だけが実物になる。4 が要るのは、**RLS だけが止めている状態を
 * 「締まっている」と読まない**ためで、2026-09-09 に `connector_limits` が実際にそうだった。
 *
 * ## 守れない範囲（設計上の限界。これは仕様であって不具合ではない）
 *
 * 1. **宣言に載っていない表は見ない。** 新しい表を作って宣言に足さなければ、
 *    既定の広い GRANT を持ったまま素通りする。`check:allowlist` と同じ穴である
 * 2. **RLS のポリシー本体は見ない。** ここが見るのは GRANT と、3本の実試行だけ。
 *    ポリシーの USING / WITH CHECK の正しさは `tests/integration/rls.test.ts` の責任
 * 3. **実DBが要る。** `requires: live-db` なので `verify` には載せられない
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import { PROBES, probe } from "./probe-table-grants";

const CHECKLIST = "docs/checklists/table-grants.yml";
const MIGRATION = "supabase/migrations/00038_revoke_write_grants.sql";

/** insufficient_privilege。**3本の試行はこれで断られなければならない** */
const INSUFFICIENT_PRIVILEGE = "42501";

/**
 * **42501 だけでは足りない。断った層まで見る。**
 *
 * 2026-09-09 の実測で `INSERT connector_limits` は 42501 で断られていたが、
 * 本文は `new row violates row-level security policy` だった。
 * **GRANT は残ったままで、書き込みポリシーが1本も無いことだけが止めていた。**
 * ポリシーを足した瞬間に通る形なので、「42501 が出たから締まっている」と読まない。
 *
 * GRANT の層で断られたときの本文は `permission denied for table <表名>` になる。
 */
const DENIED_BY_GRANT = /permission denied for table/;

interface Declaration {
  read_only: string[];
  writable: string[];
  /** `writable` の表で `authenticated` に**残す**権限。許可を明示側に持つ */
  writable_privileges: string[];
  never_granted: string[];
}

export function loadDeclaration(path = CHECKLIST): Declaration {
  const doc = parse(readFileSync(path, "utf8")) as Partial<Declaration>;
  if (
    !doc.read_only?.length ||
    !doc.writable?.length ||
    !doc.writable_privileges?.length ||
    !doc.never_granted?.length
  ) {
    // **空の一覧を「一致した」と読ませない。** fail-closed
    throw new Error(
      `${path}: read_only / writable / writable_privileges / never_granted のいずれかが空である`,
    );
  }
  return doc as Declaration;
}

/** migration の `DECLARE` にある配列を読む。**人が書き写した一覧がずれていないか** */
export function migrationArrays(source: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const name of ["read_only", "writable", "never"]) {
    const pattern = String.raw`\s+TEXT\[\]\s*:=\s*ARRAY\[([^\]]*)\]`;
    const m = new RegExp(name + pattern, "s").exec(source);
    if (!m) throw new Error(`${MIGRATION}: 配列 ${name} が見つからない`);
    out[name] = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  }
  return out;
}

/** 実DBの GRANT を表ごとに引く */
function liveGrants(dbUrl: string): Map<string, Set<string>> {
  const sql =
    "SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants " +
    "WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')";
  const out = execFileSync("psql", [dbUrl, "-A", "-t", "-F", "\t", "-c", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const map = new Map<string, Set<string>>();
  for (const line of out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)) {
    const [grantee, table, priv] = line.split("\t");
    const key = `${grantee}:${table}`;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(priv);
  }
  return map;
}

export function compareDeclarationToMigration(decl: Declaration, source: string): string[] {
  const arrays = migrationArrays(source);
  const findings: string[] = [];
  const pairs: [string, string[], string[]][] = [
    ["read_only", decl.read_only, arrays.read_only],
    ["writable", decl.writable, arrays.writable],
    ["never_granted", decl.never_granted, arrays.never],
  ];
  for (const [label, declared, inMigration] of pairs) {
    const a = [...declared].sort().join(",");
    const b = [...inMigration].sort().join(",");
    if (a !== b) {
      findings.push(`[drift] ${label}: 宣言は [${a}] だが ${MIGRATION} の配列は [${b}]`);
    }
  }
  return findings;
}

function compareDeclarationToLive(decl: Declaration, grants: Map<string, Set<string>>): string[] {
  const findings: string[] = [];
  const writes = ["INSERT", "UPDATE", "DELETE"];

  for (const t of decl.read_only) {
    const held = grants.get(`authenticated:${t}`) ?? new Set<string>();
    for (const p of writes) {
      if (held.has(p))
        findings.push(`[extra] authenticated が ${t} に ${p} を持っている（読むだけの表）`);
    }
    if (!held.has("SELECT")) findings.push(`[missing] authenticated が ${t} を読めない`);
  }

  for (const t of decl.writable) {
    const held = grants.get(`authenticated:${t}`) ?? new Set<string>();
    // **許可側の一覧から引く。** 「残す約束」を人が2か所に書き写さない
    for (const p of decl.writable_privileges) {
      if (!held.has(p))
        findings.push(`[missing] authenticated が ${t} に ${p} できない（残す約束）`);
    }
  }

  for (const t of [...decl.read_only, ...decl.writable]) {
    const held = grants.get(`authenticated:${t}`) ?? new Set<string>();
    for (const p of decl.never_granted) {
      if (held.has(p)) findings.push(`[extra] authenticated が ${t} に ${p} を持っている`);
    }
    if ((grants.get(`anon:${t}`) ?? new Set()).size > 0) {
      findings.push(`[extra] anon が ${t} に権限を持っている`);
    }
  }
  return findings;
}

function main() {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    throw new Error("SUPABASE_DB_URL が未設定のため実DBを照会できない（requires: live-db）");
  }

  const decl = loadDeclaration();
  const findings = [
    ...compareDeclarationToMigration(decl, readFileSync(MIGRATION, "utf8")),
    ...compareDeclarationToLive(decl, liveGrants(dbUrl)),
  ];

  // 3方向目。**実際に叩いて断られること。** GRANT の一覧は結果を見せない
  console.log("--- 実試行（SET ROLE authenticated・いずれも ROLLBACK する）");
  for (const p of PROBES) {
    const o = probe(p.label, p.body, dbUrl);
    const shown = o.sqlstate || "(エラーなし＝通った)";
    console.log(
      `  ${p.label}: SQLSTATE ${shown}${o.stdout ? ` / ${o.stdout.replace(/\n/g, " ")}` : ""}`,
    );
    if (o.sqlstate !== INSUFFICIENT_PRIVILEGE) {
      findings.push(
        `[allowed] 「${p.label}」が ${INSUFFICIENT_PRIVILEGE} で断られない（SQLSTATE ${shown}）`,
      );
    } else if (!DENIED_BY_GRANT.test(o.stderr)) {
      // **RLS が止めているだけの状態を「締まっている」と読まない**
      findings.push(
        `[rls-only] 「${p.label}」は 42501 だが GRANT の層で止まっていない: ${o.stderr.split("\n")[0]}`,
      );
    }
  }

  if (findings.length > 0) {
    console.error(`\ncheck:table-grants — 権限の不一致 ${findings.length}件:\n`);
    for (const f of findings) console.error(`  ${f}`);
    process.exit(1);
  }

  console.log(
    `\ncheck:table-grants — 読むだけ ${decl.read_only.length}表 / 書き込みあり ${decl.writable.length}表が` +
      `宣言どおり（${decl.never_granted.join(" / ")} はどの表にも無い。実試行 ${PROBES.length}本すべて 42501）`,
  );
}

if (process.argv[1] && process.argv[1].endsWith("check-table-grants.ts")) main();
