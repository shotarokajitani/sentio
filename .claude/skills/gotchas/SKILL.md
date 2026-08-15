---
name: gotchas
description: 実際に踏んだ失敗の蓄積。原因調査・実装判断で迷ったら最初に参照。新しい失敗は必ずここに追記。
---

# Gotchas（実績ベース）

- Stripe: サブスクで billing_address_collection / customer_creation → 500エラー（Lauda実績）
- KING OF TIME: JST 8:30–10:00 / 17:30–18:30 接続禁止。cronはUTC 02:00以降
- BOJ API: 本番公開時に post.rsd17@boj.or.jp へ通知＋クレジット表示が必要
- Slack: 2025/5/29以降、非Marketplaceアプリの conversations.history は1req/分・15件（9/2以降既存にも適用）→遡及不可、前向き収集のみ
- Supabase Vault: INSERT文がstatement logに平文で残る→statement logging OFF必須。復号はdecrypted_secretsビュー
- Instagram: インサイトの過去遡及は弱い（前向き収集型）。アプリレビュー必須・レート制限あり
- docx正本問題: docxは環境によりzipとして読めない。正本は必ずMarkdown、docxは配布用エクスポート
- 週次「問い」の詰め込み: Findingは0〜2件。3件以上は読了率が落ちる前提で設計（統制ルール）
- GBP API: 有効化と承認は別物。クォータ0 QPM=未承認、300=承認済み。申請はapi_defaultフォーム（Basic API Access）、
  60日以上アクティブな自社GBP＋オーナー権限メールが要件（Lauda実地・2026-07）
- Vault実装（security definer関数・トークン暗号化・180日削除）はLaudaに本番稼働コードあり。新規発明せず移植する
- AIクローラ（GPTBot/ClaudeBot/PerplexityBot等）はJSを実行しない。公開ページを作る場合は初期HTML/SSGが必須（Lauda調査・2026-06時点）
- Resend: onboarding@resend.devフォールバックはサンドボックス扱い。アカウントオーナー以外に届かない。RESEND_FROM未設定時はfail-closedにすること。また外部APIのfetch()レスポンスは必ずステータスコードを確認し、未確認のまま"ok"を返さないこと（Day0未着事故・2026-07-28）
- 配信Function環境変数: RESEND_API_KEY未設定時に黙ってスキップして"ok"を返すと設定漏れが検知できない。RESEND_API_KEY・RESEND_FROMの両方が未設定ならstatus:"error"で即返却すること。「キーが無いから静かにスキップ」は事故の再演（2026-07-29追記）
- メールHTML: Gmailはdivレイアウト・`<style>`タグ・外部CSS・Webフォントを除去する。テーブルベース＋インラインstyle＋600px幅＋システムフォント＋XHTML DOCTYPEが必須。text版も併せてマルチパート送信すること（Day0文字化け事故・2026-07-29）
- OAuthトークンリフレッシュ: Google/freeeともaccess_tokenは1時間で失効。refresh_tokenで自動更新しないと連携翌日に停止する。リフレッシュ失敗時はfail-closed（reauth_required）。Vault secretの更新にはupdate_vault_secret関数（00017）を使うこと（2026-08-07）
- tsconfig.json: supabase/functionsはDeno用のためexcludeされている。_shared/をNode側テストからimportする場合は`@edge/*`パスエイリアス＋exclude対象を`supabase/functions/*/index.ts`に限定すること（2026-08-07）
- pnpm-lock.yaml: 手編集・手動追記は禁止。lockfile変更時は必ず`pnpm install`で再生成する。検証はclean環境（node_modules削除後）での`pnpm install --frozen-lockfile`を必須とする。`devEngines.packageManager`は`packageManagerDependencies`をlockfileに書き込み、multi-document YAML形式を生成する原因になるため使用禁止。`packageManager`フィールドのみで管理する（2026-08-12）
- supabase db push: `--project-ref`フラグは廃止済み（`Unrecognized flag: --project-ref in command supabase db push`で失敗）。CIでは`supabase link --project-ref "$REF"`を先に実行し、`supabase db push --linked`を使う。`supabase functions deploy`側は`--project-ref`が今も有効なので、同じワークフロー内でもフラグの扱いが揃っていない点に注意。setup-cliの`version: latest`はCLIの破壊的変更をそのまま踏むため、ワークフロー故障時はまずCLIのフラグ仕様変更を疑う（deploy #31559757735・2026-08-12）
- esm.sh単一障害点: Edge Functionのimportを`https://esm.sh/...`にすると、esm.shが落ちた瞬間に全functionのバンドルが失敗する（実際に`Import 'https://esm.sh/@supabase/supabase-js@2' failed: 522`でデプロイ停止）。Deno標準の`npm:`指定子を使うこと（`npm:@supabase/supabase-js@2`）。`npm:`はSupabase Edge Runtimeがネイティブ対応しておりCDNを経由しない。新規Edge Functionでesm.shを書かない
- デプロイ順序とfail-open禁止: migrationsを先・functionsを後にする（`needs: [verify, deploy-migrations]`）。逆順や並列だと「関数はデプロイ済みだがそれが呼ぶDB関数が未適用」の不整合が残る（00017未適用のままsync-connectionsが本番に出た事故・2026-08-12）。またfunctionを個別stepに分ける際、`|| true`や`continue-on-error: true`でエラーを吸収してはいけない（Slice 1欠陥#6/#7と同型のfail-open）。`if: ${{ !cancelled() }}`なら後続stepを実行しつつ失敗はジョブ失敗として顕在化する
- migration履歴のドリフト（旧プロジェクト由来）: `supabase db push`は「remoteに適用済みだがlocalに無いバージョン」を検出すると`Remote migration versions not found in local migrations directory.`で中断する。Sentioの本番には**アーカイブ済み旧プロジェクトの履歴2件（20260414183617 / 20260414183945）が残っており**、`archive/legacy`ブランチの`supabase/migrations/20260414_*.sql`が出所。同じSupabaseプロジェクトを作り直さずにスキーマを刷新した場合に必ず起きる。**修復（`migration repair`）の前に本番の実スキーマを必ず診断すること**（`docs/runbooks/2026-08-12_migration-state-diagnosis.md`）。履歴だけ直すと、旧テーブル残存時に`00013_enable_rls_all.sql`のRLSアサーションが`RAISE EXCEPTION`で発火し、00001〜00012がコミット済みの**部分適用状態**で止まる。さらに`00014`の`GRANT ... ON ALL TABLES IN SCHEMA public`が旧テーブルにも`anon` SELECTを付与する（deploy #31576330545・2026-08-12）
- Dashboard SQL Editorでの適用は履歴に残らない: `supabase_migrations.schema_migrations`に記録されるのはCLI/CI経由の`db push`のみ。Dashboardで流したDDLは記録されないため、「履歴に無い＝スキーマにも無い」は成り立たない。本番状態の判断は履歴ではなく**実オブジェクトの存在確認**で行うこと
- マイグレーションの再実行安全性: `00015_alter_delivery_log_union_schema.sql`は`UPDATE delivery_log SET delivery_type = frame`の後に`DROP COLUMN IF EXISTS frame`を実行するため、**2回目は`column "frame" does not exist`で失敗する**。他の00001〜00018は`IF NOT EXISTS` / `DO $$ EXCEPTION WHEN duplicate_object` / `CREATE OR REPLACE` / `cron.schedule`上書きで再実行安全。列を参照するDML行は必ず列存在ガードで包むこと
- hooksの相対パス自爆: `.claude/settings.json`のhookコマンドを`node .claude/hooks/x.mjs`と相対指定すると、セッションのcwdがサブディレクトリに移った瞬間に`MODULE_NOT_FOUND`となり、hookがfail-closedで**Bash/Read/Edit/Writeを全てdenyしてセッションが自縄自縛になる**（`cd supabase/migrations`で実際に発生）。自力で復旧できないのは、設定を直すためのEdit自体がブロックされるため。必ず`node "$CLAUDE_PROJECT_DIR/.claude/hooks/x.mjs"`と絶対指定すること（2026-08-12）
- default privilegesは自前のALTER DEFAULT PRIVILEGESを消しても無くならない: Supabaseホスト環境はプロジェクト初期化時に`anon`/`authenticated`/`service_role`向けのデフォルト権限を**プラットフォーム側で**設定している。マイグレーションから自前の`ALTER DEFAULT PRIVILEGES`を削除しても、`public`に新規作成したテーブルには**ビルトインのデフォルト権限が付く**。したがって「権限は明示しないと付かない＝fail-closed」は**ローカル(supabase start)でしか成立しない**。新テーブルの安全の本線はGRANT側ではなく、**CLAUDE.md絶対規則「全テーブルRLS必須」**（RLS有効かつポリシー未定義なら非superuserから全拒否＝fail-closed）である。`00013`のRLS検証リストへの追記漏れは、GRANTの追記漏れと違って**エラーにならず静かに全公開になる**ため、新テーブル追加時は00013への追記を最優先で確認すること（2026-08-15）
- skipされ続けるテストは腐る: `tests/integration/ingest-calendar.test.ts`の「全てのoccurred_atが過去である」は、CIにSUPABASE_*が無くskipされ続けた結果、**毎月1〜14日には必ず落ちる状態**で放置されていた（フィクスチャが`monthsAgo=0`＝当月15日を含むため未来日になる。CI実行日2026-08-14 UTCで約17時間先の日付を生成）。skipは「pass」ではなく「未検証」であり、緑のCIが実態を保証しない。統合テストをskip可能にするなら、**skipされている事実と件数を必ず可視化**すること。日付フィクスチャは月末日への`setMonth`桁溢れも起こすため、日を固定してから月を引く（2026-08-15）
- workflow YAMLの無引用スカラー: ステップ名やジョブ名に`": "`（コロン+空白）を含めると、YAMLがマッピングとして解釈し**ワークフロー全体が構文エラーで1ジョブも起動しない**（`- name: deno check (npm: 指定子の解決...)`で発生。GitHubは「This run likely failed because of a workflow file issue」としか出さず、`gh run view`にもジョブが一切現れないため原因が読めない）。`npm:` `npm:@scope/pkg` 等を名前に書くときは必ず引用符で囲む。push前に`node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/ci.yml','utf8'))"`でパースを通すこと（2026-08-15）
- リモート実物検証: ローカルで修正→テストPASS→コミット・プッシュしても、リモートの実物が意図通りとは限らない。コミット時にgit addが漏れている・.gitattributes等でファイルが変換される等の原因がある。push後は`git show origin/branch:path`でリモート実物を引用確認すること。「ローカルPASS」の申告とリモート実物の乖離はVercel Preview等のCI失敗として顕在化する（2026-08-12）
