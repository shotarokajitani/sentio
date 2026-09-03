/// <reference types="node" />

/**
 * アカウント削除の「消し漏れ」を機械で止める（発注3 の 3-1）。
 *
 * **なぜ必要か。**
 * アカウント削除は当面 `docs/runbooks/2026-08-20_account-deletion.md` の手作業である。
 * 手順書の DELETE 列挙は人が書いた台帳なので、**テーブルが増えたときに追記を忘れると、
 * 消し残しが静かに残る。** これは `07_open_items.md`「アカウント削除APIの実装」が
 * 2026-08-20 の登録時点で「3 が一番危ない」と予告していた形そのものである。
 *
 * **予告どおり現物が出た。** 2026-09-03 の実測で `known_explanations` が列挙から
 * 漏れていた（`company_id` を持つテーブル11件に対し、手順書の DELETE は10件）。
 * プライバシーポリシー §6 は「当該アカウントに紐づくすべてのデータを削除します」と
 * **公開済み**なので、消し残しはそのまま約束違反になる。
 *
 * **原則（発注3 の 2-1）。** `company_id` を持つテーブルは**全件が DELETE の既定対象**である。
 * 残すものがある場合は、`docs/checklists/deletion-coverage.yml` の `keep` に
 * **「残す理由」を書いて**例外として挙げる。「消す理由」は書かない。既定が削除だからである。
 *
 * 正本は `docs/checklists/deletion-coverage.yml`。
 * 実DBが要るので `ci.integration` に載せる（`verify` には載せられない）。
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { fetchPublicColumns, toColumnMap } from "./live-schema";

/** 既定対象から外すテーブルと、**残す理由**。 */
export interface KeepEntry {
  table: string;
  reason: string;
}

export type DeletionFindingKind = "uncovered" | "stale-delete" | "keep-without-column";

export interface DeletionFinding {
  kind: DeletionFindingKind;
  table: string;
}

/**
 * 突合は**両方向**に取る。
 *
 * - `uncovered`: `company_id` を持つのに手順書が消していない（**消し残し**。これが本命）
 * - `stale-delete`: 手順書が消しているのに、そのテーブルに `company_id` が無い
 *   （改名・削除に手順書が追随していない）
 * - `keep-without-column`: `keep` に挙がっているのに `company_id` を持たない
 *   （例外の宣言が古い。放置すると例外が積み上がって意味を失う）
 *
 * **最初の1件で止めない。** 3種を同時に出す。
 */
export function compareDeletionCoverage(
  withCompanyId: Set<string>,
  deleted: Set<string>,
  keep: KeepEntry[],
): DeletionFinding[] {
  const kept = new Set(keep.map((k) => k.table));
  const findings: DeletionFinding[] = [];

  for (const t of [...withCompanyId].sort()) {
    if (!deleted.has(t) && !kept.has(t)) findings.push({ kind: "uncovered", table: t });
  }
  for (const t of [...deleted].sort()) {
    if (!withCompanyId.has(t)) findings.push({ kind: "stale-delete", table: t });
  }
  for (const t of [...kept].sort()) {
    if (!withCompanyId.has(t)) findings.push({ kind: "keep-without-column", table: t });
  }

  return findings;
}

/** 手順書の SQL から `delete from public.<table>` を抜く。 */
export function parseRunbookDeletes(markdown: string): Set<string> {
  const out = new Set<string>();
  for (const m of markdown.matchAll(/delete\s+from\s+public\.([a-z_]+)/gi)) {
    out.add(m[1].toLowerCase());
  }
  return out;
}

export interface Declaration {
  runbook: string;
  keep: KeepEntry[];
}

export function loadDeclaration(path = "docs/checklists/deletion-coverage.yml"): Declaration {
  const doc = parse(readFileSync(path, "utf8")) as Partial<Declaration>;
  if (!doc?.runbook) {
    throw new Error(`${path} に runbook が無い。参照先が空だと突合が空振りして緑になる`);
  }
  return { runbook: doc.runbook, keep: doc.keep ?? [] };
}

/** 実DBから `company_id` を持つテーブルを引く。**手順書でもコードでもなく実物を見る。** */
export function tablesWithCompanyId(dbUrl = process.env.SUPABASE_DB_URL): Set<string> {
  const map = toColumnMap(fetchPublicColumns(dbUrl));
  const out = new Set<string>();
  for (const [table, cols] of map) {
    if (cols.has("company_id")) out.add(table);
  }
  if (out.size === 0) {
    throw new Error(
      "company_id を持つテーブルが実DBに1つも無い。照会が空振りしている可能性が高く、" +
        "0件を根拠に緑を返さない",
    );
  }
  return out;
}

const DETAIL: Record<DeletionFindingKind, string> = {
  uncovered:
    "company_id を持つのに手順書の DELETE 列挙に無い。**消し残しになる。** " +
    "消すなら手順書に足す。残すなら deletion-coverage.yml の keep に**残す理由**を書く",
  "stale-delete":
    "手順書が消しているが、このテーブルは company_id を持たない。改名・削除に手順書が追随していない",
  "keep-without-column":
    "keep に挙がっているが company_id を持たない。例外の宣言が実物より古い",
};

function main(): never {
  const decl = loadDeclaration();
  const deleted = parseRunbookDeletes(readFileSync(decl.runbook, "utf8"));
  if (deleted.size === 0) {
    console.error(
      `check:deletion-coverage — ${decl.runbook} から delete 文を1つも読めなかった。` +
        "手順書の書式が変わった可能性がある。0件を根拠に緑を返さない",
    );
    process.exit(1);
  }

  const withCompanyId = tablesWithCompanyId();
  const findings = compareDeletionCoverage(withCompanyId, deleted, decl.keep);

  if (findings.length === 0) {
    console.log(
      `check:deletion-coverage — company_id を持つ ${withCompanyId.size}件がすべて` +
        `手順書の DELETE 列挙（${deleted.size}件）か keep（${decl.keep.length}件）に載っている`,
    );
    process.exit(0);
  }

  console.error(`check:deletion-coverage — 削除範囲の不一致 ${findings.length}件:`);
  for (const f of findings) {
    console.error(`  [${f.kind}] ${f.table}`);
    console.error(`      ${DETAIL[f.kind]}`);
  }
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
