import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // next dev は既定で CLAUDE.md / AGENTS.md にエージェント向けブロックを自動追記する。
  // CLAUDE.md はプロジェクト憲法＝人間承認事項なので、ツールによる書き換えを禁じる。
  // Next.js版のドキュメント参照ルールは .claude/rules/nextjs.md に手で収載済み。
  agentRules: false,
};

export default nextConfig;
