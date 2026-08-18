# Next.js 層の規約

このリポジトリの Next.js は **訓練データの Next.js と一致しない**。
API・規約・ファイル構成が変わっている前提で扱う。

## ドキュメントの参照先

コードを書く前に `node_modules/next/dist/docs/` の該当ガイドを読む。
訓練データの記憶を正としない。非推奨警告（deprecation notice）は無視せず、
移行の要否をその場で判断する。

この規約の出所は `next dev` が自動生成するエージェント向けブロック
（実装: `node_modules/next/dist/server/lib/generate-agent-files.js`）である。
自動追記そのものは禁止（下記）としたうえで、**内容は人間承認のうえ手でここに収載した**。

## CLAUDE.md の自動書き換えを禁じる

`next dev` は既定（`agentRules: true`）で `CLAUDE.md` / `AGENTS.md` に
`<!-- BEGIN:nextjs-agent-rules -->` ブロックを自動追記する
（定義: `node_modules/next/dist/server/config-shared.d.ts` の `agentRules?: boolean`）。

`CLAUDE.md` はプロジェクト憲法であり**人間承認事項**なので、ツールによる書き換えは受け入れない。
`next.config.ts` に `agentRules: false` を設定済み。**この設定を外さないこと。**

2026-08-18 に実際に混入し、コミット前に `git checkout HEAD -- CLAUDE.md` で除去した。

## 要判断（未確定・実施はバックログ）

- **`middleware` → `proxy` への移行。**
  `next dev` 起動時に
  `⚠ The "middleware" file convention is deprecated. Please use "proxy" instead.`
  が出る。自動移行コーデック `npx @next/codemod@canary middleware-to-proxy .` が提供されている。
  ただし本リポジトリの認証境界は middleware に依存しており（未認証を弾く fail-closed）、
  移行はスライスAの範囲外。**どちらを正とするかは未判断。勝手に移行しない。**
