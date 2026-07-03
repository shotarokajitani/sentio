---
paths: ["**"]
---

- トークン・鍵をコード・イベント・ログ・ドキュメント・テストフィクスチャに書かない。K2はVaultのみ
- Vaultアクセスはsecurity definer関数経由・service_role限定。statement loggingはOFF前提
- 本番Project Ref kwpldqbnkraftaahnpev へのCLI直接操作禁止。本番反映はCIのみ
- 受信Webhookは署名検証必須（Stripe/Slack/LINE）。検証なしのエンドポイントを作らない
- 新テーブルはRLSポリシーとセットでのみ作成。NEXT_PUBLIC_に秘密を置かない
- Stripeサブスクで billing_address_collection / customer_creation を渡さない
