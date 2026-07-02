# 05 セキュリティ章（秘匿情報・実装運用）

## 秘匿情報4分類と保管
- K1 サービス鍵（Anthropic/Stripe秘密鍵＋Webhook署名/Resend/gBizINFO/OAuthクライアント群/service_role）
  → 本番: Supabase Edge Function Secrets。Vercelはサーバー専用env。NEXT_PUBLIC_に秘密を置くこと禁止。
- K2 顧客OAuthトークン（最重要・増え続ける）→ Supabase Vaultを正とする。
  規則: ①security definer関数に包みservice_roleのみ実行可 ②statement logging無効化（INSERT平文ログ対策・公式gotcha）
  ③トークンは他のどこにも存在させない（エンベロープ/entities/logsにトークン型フィールドなし。allowlist検査対象）
  接続台帳connections: company_id/provider/vault_secret_id/scopes/status/last_refresh/expires_at（鮮度監視の入力）。
  スコープは常に最小（readonly・metadata）。
- K3 開発・CI鍵 → GitHub Actions Secrets（環境別）。Claude Code実行環境に本番鍵ゼロ（構造保証）。
- K4 人間のルート認証 → パスワードマネージャを台帳の正。全ダッシュボード2FA＋復旧コード＋緊急アクセスキット。
  文書には値を書かずポインタのみ。

## ライフサイクル
- 発行: 環境別鍵。Anthropicはdev/prod分割＋支出上限・アラート必須。OAuthアプリもdev別。
- ローテーション: 年1＋事故時即時。二重登録→切替→旧失効の無停止手順。runbookに鍵ごとの使用箇所・手順・影響範囲（値なし）。
- 失効: 接続解除・解約時はプロバイダrevoke→Vault削除。トークンは180日を待たず即時削除（例外として明記）。
- 監視: Stripe/Anthropic支出アラート・Sentryスクラビング（トークン/PIIマスク）・refresh失敗率・gitleaks/push protection。
- インシデント: 検知→revoke/rotate→影響評価→個人データ漏えい該当時は個人情報保護委員会報告・本人通知の要否判断→Gotchas追記
  （docs/incident.md）。

## 開発工程の防御（hooks 5本）
①.env読取拒否（.env.exampleのみ許可）②pre-commit gitleaks ③本番Project RefへのCLI操作拒否
④S2/トークンのallowlistマイグレーション検査 ⑤Edge Functionのトークンログ出力禁止（lint）
＋受信Webhook署名検証（Stripe/Slack/LINE）を全スライス契約の固定基準に。
合成会社フィクスチャに実在人名・実鍵を含めない（生成スクリプト側で保証）。

## 環境
Generatorはローカル/プレビューのみ操作可。本番反映はCI/CDパイプライン経由のみ（マージ後自動適用）。
Supabaseプレビューブランチのcron/secrets/Vault再現範囲は要確認（07）。年1回、Vault移行手順の机上確認
（実害は顧客の再OAuth1回で収まることを確認済み: トークンは再発行可能な秘密であり、State層の記憶とは分離）。

## 実装の移植元（平仄）
K2のVaultアクセスパターン（security definer関数・service_role限定・SHA-256ハッシュ・180日削除）は
Laudaで本番稼働済み。Sentioは新規発明せずLauda実装を移植し、差分（接続台帳connections・即時削除ルール）のみ追加する。
移植後、このパターンをディセーノ共通skillとして切り出す（gotchas参照）。
