# secrets-runbook（値は一切書かない。値の正はパスワードマネージャ）

各鍵: [名称 / 分類K1-K4 / 使用箇所 / 発行元URL / ローテーション手順 / 影響範囲] の5点で管理する。
無停止ローテーション標準手順: 新鍵を併行登録 → 参照切替 → 動作確認 → 旧鍵失効。

対象一覧（初期）: ANTHROPIC_API_KEY(dev/prod) / STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET /
RESEND_API_KEY / SLACK_CLIENT_ID・SECRET / CHATWORK_CLIENT_ID・SECRET / GOOGLE_CLIENT_SECRET /
GBIZINFO_TOKEN / ESTAT_APP_ID / (追加時にここへ行を足す)
顧客トークン: Vaultのみ。運用は 05_security.md の規則に従う。
年1確認: Vault移行手順の机上確認 / 全鍵の棚卸し / 緊急アクセスキットの有効性。
