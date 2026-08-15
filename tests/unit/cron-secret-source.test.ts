import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");

function readMigration(prefix: string): string {
  const file = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith(prefix));
  if (!file) throw new Error(`migration not found: ${prefix}`);
  return readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
}

/**
 * 行コメントを除いた「実行されるSQL」だけを取り出す。
 * 移行の経緯としてコメントに app.settings と書くのは正当なので、
 * コメントごと検査すると経緯の記述そのものが書けなくなる。
 */
function executableSql(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

/**
 * cron が秘密をどこから取るかの回帰ガード。
 *
 * GUC方式（app.settings.*）は本番で
 *   ERROR: 42501: permission denied to set parameter
 * となり経路が塞がっている（2026-08-15実測）。設定できない以上、
 * cron本文がGUCを参照した状態に戻ると6時間ごとに静かに失敗し続ける。
 * 本番でしか再現しない故障なので、ファイル側で固定する。
 */
describe("cronジョブの秘密取得元", () => {
  const m00020 = readMigration("00020_");

  it("00020 は cron を Vault 参照で再登録する", () => {
    expect(m00020).toContain("cron.schedule");
    expect(m00020).toContain("read_vault_secret_by_name");
  });

  it("00020 は GUC(app.settings.*) を参照しない", () => {
    expect(executableSql(m00020)).not.toContain("app.settings");
  });

  it("シークレット名が定数として明示されている", () => {
    expect(m00020).toContain("'sentio_supabase_url'");
    expect(m00020).toContain("'sentio_service_role_key'");
  });

  it("人間向け登録手順のシークレット名が 00020 と一致する", () => {
    const procedure = readFileSync(
      path.resolve(__dirname, "../../docs/runbooks/2026-08-15_vault-secret-setup-procedure.md"),
      "utf8",
    );
    // 名前がずれると cron が `vault secret not found` で失敗する
    expect(procedure).toContain("sentio_supabase_url");
    expect(procedure).toContain("sentio_service_role_key");
  });

  it("Vaultヘルパーは service_role 限定（anon/authenticated から剥奪）", () => {
    expect(m00020).toContain("REVOKE EXECUTE ON FUNCTION read_vault_secret_by_name(TEXT)");
    expect(m00020).toContain(
      "GRANT EXECUTE ON FUNCTION read_vault_secret_by_name(TEXT) TO service_role",
    );
  });

  it("00020 より後に GUC 方式へ戻すマイグレーションが無い", () => {
    const later = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql") && f >= "00020")
      .filter((f) =>
        executableSql(readFileSync(path.join(MIGRATIONS_DIR, f), "utf8")).includes("app.settings"),
      );
    expect(later, `GUC参照を含む: ${later.join(", ")}`).toHaveLength(0);
  });
});
