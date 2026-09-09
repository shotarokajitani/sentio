/// <reference types="node" />

/**
 * `authenticated` が実際に何をできるかを、**実DBに当てて測る**（発注 ①-1.5）。
 *
 * `information_schema.role_table_grants` は GRANT を見せるだけで、
 * **RLS と合わせて最終的に何が通るか**は見せない。両方を通した結果だけが実物である。
 *
 * `psql` を使うのは `scripts/live-schema.ts` と同じ理由——依存を1つも増やさないため。
 * PostgREST では `TRUNCATE` を発行できず、`SET ROLE` も掛けられない。
 *
 * **どの試行もトランザクションごと ROLLBACK する。** 権限が残っていて成功した場合でも
 * 実DBは変わらない。この script は測るだけで、直しはしない（直しは 00038）。
 */

import { execFileSync } from "node:child_process";

const SUB = "11111111-1111-1111-1111-111111111111";

export interface ProbeOutcome {
  label: string;
  /** 42501 = insufficient_privilege。空文字はエラーにならなかったことを表す */
  sqlstate: string;
  /** psql の標準出力（`UPDATE 0` などのコマンドタグを含む） */
  stdout: string;
  stderr: string;
}

/** 1つの試行を独立した psql 呼び出しで走らせる。**最後は必ず ROLLBACK。** */
export function probe(label: string, body: string, dbUrl = process.env.SUPABASE_DB_URL) {
  if (!dbUrl) throw new Error("SUPABASE_DB_URL が未設定のため実DBに当てられない");

  // `\set` は `-c` の中では使えない。SQL として解釈され
  // `syntax error at or near "verbose"` になる（2026-09-09 CI で実測）。
  // psql 変数は `-v` で渡す。verbose にすると SQLSTATE が
  // `ERROR:  42501: permission denied ...` の形で本文の先頭に出る
  const sql = `BEGIN;\n${body}\nROLLBACK;\n`;
  try {
    const args = [dbUrl, "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-c", sql];
    const stdout = execFileSync("psql", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { label, sqlstate: "", stdout: stdout.trim(), stderr: "" };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    const stderr = err.stderr ?? err.message;
    // verbose では `ERROR:  42501: permission denied ...`。行頭に psql の接頭辞が付くので
    // 行頭固定にしない。念のため `SQLSTATE 42501` の形も拾う
    const m = /ERROR:\s+(\d{5}):/.exec(stderr) ?? /SQLSTATE\s+(\w+)/.exec(stderr);
    return {
      label,
      sqlstate: m ? m[1] : "?",
      stdout: (err.stdout ?? "").trim(),
      stderr: stderr.trim(),
    };
  }
}

/** `authenticated` として、自社ユーザーのセッションを作る前置き */
const AS_AUTHENTICATED = `SET LOCAL ROLE authenticated;\nSET LOCAL request.jwt.claims = '{"sub":"${SUB}","role":"authenticated"}';`;

export const PROBES: { label: string; body: string }[] = [
  {
    label: "TRUNCATE events",
    // **RLS を素通しする経路。** 行を絞る仕組みは TRUNCATE には掛からない
    body: `${AS_AUTHENTICATED}\nTRUNCATE events;`,
  },
  {
    label: "INSERT connector_limits",
    // 全社共通の表。顧客が枠を書き換えられてよい理由が無い
    body: `${AS_AUTHENTICATED}\nINSERT INTO connector_limits (provider, limits) VALUES ('probe_provider', '{}'::jsonb);`,
  },
  {
    label: "UPDATE known_explanations の共有行 (company_id IS NULL)",
    // 共有行は postgres で入れてから、authenticated に降りて触りにいく
    body:
      `INSERT INTO known_explanations (company_id, kind, period, source, auto)\n` +
      `  VALUES (NULL, 'probe_kind', '2026-09', 'probe', false);\n` +
      `${AS_AUTHENTICATED}\n` +
      `UPDATE known_explanations SET source = 'tampered' WHERE company_id IS NULL;`,
  },
];

export function runProbes(dbUrl = process.env.SUPABASE_DB_URL): ProbeOutcome[] {
  return PROBES.map((p) => probe(p.label, p.body, dbUrl));
}

if (process.argv[1] && process.argv[1].endsWith("probe-table-grants.ts")) {
  const outcomes = runProbes();
  for (const o of outcomes) {
    console.log(`--- ${o.label}`);
    console.log(`  SQLSTATE: ${o.sqlstate || "(エラーなし＝通った)"}`);
    if (o.stdout) console.log(`  stdout: ${o.stdout.replace(/\n/g, " / ")}`);
    if (o.stderr) console.log(`  stderr: ${o.stderr.split("\n")[0]}`);
  }
}
