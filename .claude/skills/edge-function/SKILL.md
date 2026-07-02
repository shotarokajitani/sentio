---
name: edge-function
description: Supabase Edge Function（Deno）を新規作成・変更するときに必ず使用。
---
# Edge Function規約
1. 入出力はzodスキーマで契約定義し、shared/contracts/ に置いてフロントと共有
2. 冒頭で認証（service_role or ユーザーJWT）を検証。CORSは共通ヘッダユーティリティ
3. secretsは Deno.env.get のみ。値をログに出さない（トークン・PIIはマスク関数経由）
4. 失敗はstatusテーブルに記録して200/4xxで返す設計（cron連鎖を止めない）。Sentryへは文脈IDのみ
5. 外部API呼び出しは connector_limits（レート制限レジストリ）を参照
## Gotchas
- Stripe: サブスクモードで billing_address_collection / customer_creation を渡すと500（実績あり）
- Resend: 送信失敗はリトライキューへ。同一Findingの二重送信をevent_idで防ぐ
- 長時間処理は分割（Edge Functionのタイムアウト前提で設計）
