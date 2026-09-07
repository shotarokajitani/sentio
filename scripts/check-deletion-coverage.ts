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

/**
 * `company_id` を持たない経路で会社に紐づくテーブルと、**何で紐づくのか**。
 *
 * 例: `billing_webhook_unresolved` は `stripe_customer_id` でしか会社に辿れない。
 * **手順書はこれを消すが、この検査器の既定の突合では `stale-delete` に見える。**
 * 宣言しておくことで「消しているのは意図」だと分かる形にする。
 */
export interface BeyondEntry {
  table: string;
  /** 紐づけに使う列（会社を引く手掛かり） */
  via: string;
  reason: string;
}

export type DeletionFindingKind =
  | "uncovered"
  | "stale-delete"
  | "keep-without-column"
  | "beyond-with-column";

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
 * - `beyond-with-column`: `beyond_company_id` に挙がっているのに `company_id` を**持つ**
 *   （既定の突合で見られるので、例外にしておく理由が無い）
 *
 * **最初の1件で止めない。** 4種を同時に出す。
 *
 * ## この検査器が見ないもの（**射程の限界**）
 *
 * **見るのは `company_id` を持つテーブルの列挙だけである。**
 * `company_id` を持たない紐づけ（`stripe_customer_id` など）は見ない。
 * それらは `beyond_company_id` に**宣言として**書くが、
 * **宣言と実物の突合はしていない**——「消す SQL が本当にその会社の行だけを消すか」は
 * この検査器の外にある。射程を広げるかどうかは未判断
 * （`docs/spec/07_open_items.md`）。
 */
export function compareDeletionCoverage(
  withCompanyId: Set<string>,
  deleted: Set<string>,
  keep: KeepEntry[],
  beyond: BeyondEntry[] = [],
): DeletionFinding[] {
  const kept = new Set(keep.map((k) => k.table));
  const beyondTables = new Set(beyond.map((b) => b.table));
  const findings: DeletionFinding[] = [];

  for (const t of [...withCompanyId].sort()) {
    if (!deleted.has(t) && !kept.has(t)) findings.push({ kind: "uncovered", table: t });
  }
  for (const t of [...deleted].sort()) {
    // **宣言してある表は `stale-delete` にしない。** 消しているのは意図である
    if (!withCompanyId.has(t) && !beyondTables.has(t)) {
      findings.push({ kind: "stale-delete", table: t });
    }
  }
  for (const t of [...kept].sort()) {
    if (!withCompanyId.has(t)) findings.push({ kind: "keep-without-column", table: t });
  }
  for (const t of [...beyondTables].sort()) {
    if (withCompanyId.has(t)) findings.push({ kind: "beyond-with-column", table: t });
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
  beyond: BeyondEntry[];
}

export function loadDeclaration(path = "docs/checklists/deletion-coverage.yml"): Declaration {
  // YAML 側のキーは `beyond_company_id`（何の話かが読んで分かる名前にしてある）。
  // **型の名前と YAML のキーがずれていることを、ここで1箇所だけ吸収する**
  const doc = parse(readFileSync(path, "utf8")) as {
    runbook?: string;
    keep?: KeepEntry[];
    beyond_company_id?: BeyondEntry[];
  };
  if (!doc?.runbook) {
    throw new Error(`${path} に runbook が無い。参照先が空だと突合が空振りして緑になる`);
  }
  return { runbook: doc.runbook, keep: doc.keep ?? [], beyond: doc.beyond_company_id ?? [] };
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
  "beyond-with-column":
    "beyond_company_id に挙がっているが company_id を**持つ**。" +
    "既定の突合で見られるので、例外にしておく理由が無い",
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
  const findings = compareDeletionCoverage(withCompanyId, deleted, decl.keep, decl.beyond);

  if (findings.length === 0) {
    console.log(
      `check:deletion-coverage — company_id を持つ ${withCompanyId.size}件がすべて` +
        `手順書の DELETE 列挙（${deleted.size}件）か keep（${decl.keep.length}件）に載っている` +
        `（うち company_id を持たない経路の宣言 ${decl.beyond.length}件）`,
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
