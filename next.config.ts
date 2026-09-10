import type { NextConfig } from "next";
import { NEXT_MAIL_ENV_KEYS } from "./src/lib/mail/send";

/**
 * メールの設定が Vercel 側に入っているかを、**ビルドのたびに1行出す**（発注 A-2）。
 *
 * **Vercel の環境変数は CI からは読めない。** GitHub Actions からは別プロジェクトなので、
 * 検査器を書いても照会できない。Supabase の Function Secrets に入っていても
 * Next からは見えないので、「入れたつもり」が成立してしまう。
 *
 * 唯一 Vercel の env が見えるのは**そこでビルドが走るとき**なので、ここで出す。
 * ビルドは止めない——**止めると、メールと無関係な修正まで出せなくなる。**
 */
function warnMissingMailEnv(): void {
  const missing = NEXT_MAIL_ENV_KEYS.filter((k) => !process.env[k]?.trim());
  if (missing.length === 0) {
    console.log(`[sentio] メールの設定は揃っている（${NEXT_MAIL_ENV_KEYS.join(" / ")}）`);
    return;
  }
  console.warn(
    `[sentio] メールの設定が足りない: ${missing.join(" / ")} — ` +
      "この環境からは1通も送れない。Vercel の環境変数に入れて再デプロイすること " +
      "（Supabase の Function Secrets に入れても Next からは見えない）",
  );
}

warnMissingMailEnv();

const nextConfig: NextConfig = {
  // next dev は既定で CLAUDE.md / AGENTS.md にエージェント向けブロックを自動追記する。
  // CLAUDE.md はプロジェクト憲法＝人間承認事項なので、ツールによる書き換えを禁じる。
  // Next.js版のドキュメント参照ルールは .claude/rules/nextjs.md に手で収載済み。
  agentRules: false,
};

export default nextConfig;
