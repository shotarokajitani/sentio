# インシデント対応（1ページ・5段）

1. 検知（Sentry・支出アラート・gitleaks・プロバイダ通知・refresh失敗急増）→ 事象と時刻を記録
2. 遮断: 当該鍵をrevoke/rotate（runbook該当行の手順）。顧客トークン漏えい疑いはVault該当行削除＋プロバイダrevoke
3. 影響評価: 何が・いつから・どの範囲で参照可能だったか（監査ログ・アクセスログ）
4. 法対応判断: 個人データ漏えいに該当するか→該当時は個人情報保護委員会への報告・本人通知の要否を判断（要件確認のうえ実施）
5. 事後: 根本原因→再発防止をhooks/CIに実装→ .claude/skills/gotchas に追記

---

## インシデント記録

### 2026-07-28 #1: 検証コンテナが古いカスタムイメージを使用

- **事象**: ローカル検証時に `sentio-edge-with-state:latest` という古いカスタムDockerイメージが実行されていた。公式の `supabase/edge-runtime` ではなく、いつ作られたか不明のイメージが使われており、テスト結果の信頼性が損なわれていた
- **原因**: 過去の実験で作成したカスタムイメージがローカルに残存し、docker compose設定またはsupabase設定がそれを参照し続けていた
- **対処**: 公式の `supabase/edge-runtime` を使用するよう設定を修正
- **再発防止**: CI/ローカルで使用するイメージを明示的に指定し、カスタムイメージの使用を禁止する運用ルールを設定

### 2026-07-28 #2: Day0メール未着（Resend APIレスポンス未検証）

- **事象**: Day0レポートの送信完了（status:"ok"）が報告されたが、実際にはメールが届いていなかった。迷惑メールフォルダにも存在しない
- **原因**: 4つの配信Edge Function（day0/deliver-alert/deliver-pulse/deliver-weekly）全てで、Resend APIの`fetch()`レスポンスを一切検証せず、常に`status:"ok"`を返していた。さらに`RESEND_FROM`環境変数が未設定の場合、`onboarding@resend.dev`（Resendサンドボックスアドレス）にフォールバックしており、アカウントオーナー以外への配信がResend側で拒否されていた可能性が高い。加えて`delivery_log`にはAPI呼び出し前に`status:"sent"`を記録しており、実際の送信結果が記録されていなかった
- **対処**: (1) 4つの配信Edge Function全てでResend APIレスポンスのステータスコードとemail idを確認するよう修正 (2) 成功時のみ`status:"ok"`+email_idを返し、失敗時は`status:"error"`+理由を返すよう変更 (3) `onboarding@resend.dev`フォールバックを削除し、`RESEND_FROM`未設定時はfail-closedでエラーを返すよう変更 (4) `delivery_log`の記録を送信後に移動し、実際の結果（sent/failed/skipped）を記録するよう変更
- **再発防止**: (1) 外部APIの戻り値を確認しない成功報告の禁止（スライス1契約E+1〜E+4に明文化）(2) 環境変数フォールバックでサンドボックスモードに暗黙移行するパターンの禁止 (3) gotchasスキルに追記
- **残穴是正（2026-07-29）**: git HEADの4配信Functionに`onboarding@resend.dev`フォールバック・送信前delivery_log記録・RESEND_API_KEY未設定時の沈黙スキップが残存していた。RESEND_FROM未設定のfail-closedは前回の修正セッションで追加されたがコミット前にウィンドウが閉じたため未反映だった。今回、4Function全てで(1)RESEND_API_KEY未設定→即エラー返却 (2)RESEND_FROM未設定→fail-closed (3)Resendレスポンス検証+email_id返却 (4)delivery_logを送信後に実結果で記録、の4点を統一適用。E+5基準を追加

### 2026-07-28 #3: モデルID retired により実環境テストが全停止

- **事象**: Edge Functionの全LLM呼び出しが HTTP 404 で失敗。`claude-3-haiku-20240307` がAnthropicにより retired されていた
- **原因**: モデルIDが3箇所（`investigate/index.ts` x2、`day0/index.ts` x1）にハードコードされており、retired後に一斉に動作不能となった。環境変数 `ANTHROPIC_MODEL` のフォールバック値が全て retired 済みIDだった
- **対処**: `supabase/functions/_shared/models.ts` を作成し、モデルIDを単一定義場所に集約。デフォルトを `claude-sonnet-5` に差し替え
- **再発防止**: (1) モデルIDの単一定義場所（`_shared/models.ts`）からのみ参照する運用。ハードコード禁止 (2) Anthropic API応答ヘッダの `model-deprecated` を検知して `console.warn` でログ出力する `warnIfModelDeprecated` ガードレールを全LLM呼び出しに追加

### 2026-07-29 #4: HTMLメールの描画未検証（文字化け＋レイアウト崩壊）

- **事象**: Day0レポートメールがGmailで開くと件名が文字化け（������）、本文のHTMLレイアウトが崩壊（テキスト重なり・断片化）。生成内容自体は正しいがメールとしての描画が壊れていた
- **原因**: (1) メールHTMLがdiv+CSSレイアウトで構築されており、Gmailのレンダリングエンジン（`<style>`タグ・div layoutを除去）で崩壊 (2) charsetはmeta tagにあったが、XHTML DOCTYPEとContent-Type HTTPヘッダでのcharset宣言が不足 (3) プレーンテキスト版（textフィールド）が未設定でマルチパート非対応 (4) Evaluatorは生成内容の品質を採点するが描画品質は対象外であり、実受信確認が受け入れ基準になかった
- **対処**: (1) `_shared/email-html.ts`を新規作成し、テーブルベース・インラインスタイル・600px幅のGmail互換HTMLテンプレートを4配信Function共通で使用 (2) XHTML DOCTYPE + `Content-Type: text/html; charset=UTF-8` ヘッダ付き (3) Resend APIにtext/htmlの両方を送信（マルチパート） (4) デザイントークン統一（背景#f7f5f2/アクセント#0e5070） (5) 【見えたこと】【根拠】【考えられること】の3パート構造を色分けボーダーで視覚区別
- **再発防止**: (1) E+6基準を追加（Gmail実受信での目視確認を受け入れ基準化） (2) メールHTMLの制約（テーブルベース・インラインスタイル・Webフォント不使用）をgotchasに追記

### 2026-08-07 #5: Vercel Preview ビルド全停止（devEngines vs npm 衝突）

- **事象**: 全PRのVercel Previewデプロイが `EBADDEVENGINES` で失敗。少なくとも2026-07-29以降の全デプロイが同一原因で失敗中
- **原因**: Vercelプロジェクトのインストールコマンドがnpm（デフォルト）のまま。`package.json`の`devEngines.packageManager`が`pnpm ^11.9.0`を要求しているため、npmの`EBADDEVENGINES`チェックで拒否される。加えて`Error while parsing config file: pnpm-lock.yaml`が発生しており、Vercel側でpnpm-lock.yamlの解析にも失敗している
- **影響**: Vercel Previewのみ。GitHub Actions CI（pnpm使用）・ローカルビルド（`pnpm build`成功確認済み）・本番デプロイ（deploy.yml経由Supabase CLI）は影響なし
- **対処（未実施）**: Vercel Dashboard > Project Settings > General > Install Command を `pnpm install --frozen-lockfile` に変更、またはRoot Directory設定を確認。あるいは`packageManager`フィールドが存在すればVercelが自動でpnpmを使用するはずだが、`devEngines`との競合で検出に失敗している可能性がある
- **対処（2026-08-12 実施）**: (1) pnpm-lock.yamlが2つのYAMLドキュメントが連結された壊れた状態だった（コミット54f9543での手動整合性修正時に追記ミス）。node_modules削除＋lockfile削除＋`pnpm install`で正規に再生成 (2) `packageManager`フィールドを`pnpm@11.9.0`→`pnpm@11.21.0`に更新（ローカル実行バージョンと一致させ、Vercelのcorepackが同一バージョンを使用するようにする）。なおpnpm v11.21+はmulti-document YAML形式のlockfileを生成するため、古いバージョンではパース不可
- **再発防止**: (1) Vercelプロジェクト設定のパッケージマネージャーを明示的に指定する。Preview環境のビルド成功をCIの必須チェックに含めるかは要判断（現在はオプション扱い） (2) pnpm-lock.yamlは手編集禁止。変更時は必ず`pnpm install`で再生成し、clean環境での`pnpm install --frozen-lockfile`で検証する
