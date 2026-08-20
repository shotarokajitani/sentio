/// <reference types="node" />

/**
 * 実DBの列一覧を取る。`check:allowlist`（S-5-4）と `check:schema`（S-5-1）の共通経路。
 *
 * **PostgREST 経由では取れない。** supabase-js に `db: { schema: "information_schema" }` を
 * 渡すと `Invalid schema: information_schema` で拒否される（2026-08-19 CI で実測）。
 * PostgREST が公開するのは `supabase/config.toml` の `[api] schemas` に並ぶスキーマだけで、
 * そこに `information_schema` を足すと**本番のAPI表面が広がる**。検査のために本番の穴を
 * 開けることになるので採らない。
 *
 * `security definer` の RPC を1本足す案も採らない。CI のためだけの関数を本番スキーマに
 * 常設すると、RLS・GRANT・`00013` の検証リストを巻き込む（S-7-2）。
 *
 * 残るのは **DB へ直接つなぐ**経路。`psql` を使うのは、依存を1つも増やさずに済むため
 * （CLAUDE.md「ライブラリの新規追加は提案のみ」）。接続先は `SUPABASE_DB_URL`。
 */

import { execFileSync } from "node:child_process";

export interface ColumnRow {
  table: string;
  column: string;
}

/** psql を1回叩いて public スキーマの テーブル×列 を返す。 */
export function fetchPublicColumns(dbUrl = process.env.SUPABASE_DB_URL): ColumnRow[] {
  if (!dbUrl) {
    throw new Error(
      "SUPABASE_DB_URL が未設定のため実DBを照会できない。" +
        "ローカルでは `supabase status -o env` の DB_URL を渡すこと",
    );
  }

  // 区切りは psql の -F に渡す。SQL 側で '\t' と書くと、標準の文字列リテラルでは
  // タブではなく「バックスラッシュ + t」の2文字になり、JS 側の split("\t") と噛み合わない。
  // 2026-08-19 CI で実測: この不整合により全259参照が「存在しない列」と誤判定された
  const sql =
    "SELECT table_name, column_name " +
    "FROM information_schema.columns WHERE table_schema = 'public' " +
    "ORDER BY table_name, ordinal_position";

  let out: string;
  try {
    out = execFileSync("psql", [dbUrl, "-A", "-t", "-F", "\t", "-c", sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`psql での照会に失敗: ${err.stderr?.trim() || err.message}`);
  }

  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [table, column] = line.split("\t");
      return { table, column };
    });
}

/** テーブル名 → 列名の集合。 */
export function toColumnMap(rows: ColumnRow[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!map.has(r.table)) map.set(r.table, new Set());
    map.get(r.table)!.add(r.column);
  }
  return map;
}
