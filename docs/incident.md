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

### 2026-07-28 #2: モデルID retired により実環境テストが全停止

- **事象**: Edge Functionの全LLM呼び出しが HTTP 404 で失敗。`claude-3-haiku-20240307` がAnthropicにより retired されていた
- **原因**: モデルIDが3箇所（`investigate/index.ts` x2、`day0/index.ts` x1）にハードコードされており、retired後に一斉に動作不能となった。環境変数 `ANTHROPIC_MODEL` のフォールバック値が全て retired 済みIDだった
- **対処**: `supabase/functions/_shared/models.ts` を作成し、モデルIDを単一定義場所に集約。デフォルトを `claude-sonnet-5` に差し替え
- **再発防止**: (1) モデルIDの単一定義場所（`_shared/models.ts`）からのみ参照する運用。ハードコード禁止 (2) Anthropic API応答ヘッダの `model-deprecated` を検知して `console.warn` でログ出力する `warnIfModelDeprecated` ガードレールを全LLM呼び出しに追加
