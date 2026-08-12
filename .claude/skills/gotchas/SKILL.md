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
- リモート実物検証: ローカルで修正→テストPASS→コミット・プッシュしても、リモートの実物が意図通りとは限らない。コミット時にgit addが漏れている・.gitattributes等でファイルが変換される等の原因がある。push後は`git show origin/branch:path`でリモート実物を引用確認すること。「ローカルPASS」の申告とリモート実物の乖離はVercel Preview等のCI失敗として顕在化する（2026-08-12）
