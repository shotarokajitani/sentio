import { defineConfig } from "vitest/config";
import path from "path";
import { existsSync } from "fs";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

/**
 * 送信事故の防止（契約 S-2-10）。**テストプロセスに Resend の設定を持ち込まない。**
 *
 * 上の `loadEnvFile` はローカルの `.env` を丸ごと `process.env` に載せる。
 * 2026-08-19 の実測で、この経路によりローカルのテスト実行時に `RESEND_API_KEY` が
 * 載っていることを確認した（`tests/unit/test-recipients.test.ts` が赤くなった）。
 * その状態で deliver 系のテストを書けば、**本番の鍵で実際にメールが飛ぶ。**
 *
 * `existsSync` の中ではなく外で消しているのは、シェルで export された値も落とすため。
 * 実送信を伴う検証は Edge Function を本番／プレビューに置いて手順書から叩く経路で行う。
 * テストプロセスからは構造的に送れない状態を保つ。
 */
for (const key of ["RESEND_API_KEY", "RESEND_FROM"]) {
  delete process.env[key];
}

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "shared"),
      "@edge": path.resolve(__dirname, "supabase/functions"),
    },
  },
});
