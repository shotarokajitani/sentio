import { defineConfig } from "vitest/config";
import path from "path";
import { existsSync } from "fs";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
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
