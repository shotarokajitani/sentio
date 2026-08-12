# トークンリフレッシュ本番検証手順書

実施日: 2026-08-07
対象: B-s2-1 / B-s2-2 / B-s2-3 の本番実体確認
前提: deploy.yml によるデプロイ完了後に実施

---

## 前提確認

### 1. デプロイ状態の確認

GitHub Actions の `deploy` ワークフロー実行結果を確認:
- `deploy-functions` ジョブ: sync-connections が正常にデプロイされたこと
- `deploy-migrations` ジョブ: 00017, 00018 が正常に適用されたこと

### 2. Vault権限の確認（SQL Editor）

```sql
-- update_vault_secretがservice_role限定であることを確認
-- anon/authenticatedロールから呼べないことを検証
SET ROLE authenticated;
SELECT update_vault_secret(gen_random_uuid(), 'test');
-- 期待結果: permission denied for function update_vault_secret

RESET ROLE;
```

### 3. pg_cronジョブの確認（SQL Editor）

```sql
SELECT jobid, schedule, command, nodename
FROM cron.job
WHERE jobname = 'sync-connections';
-- 期待結果: schedule = '0 0,6,12,18 * * *' のレコードが1件
```

---

## 検証A: Before状態の記録（sync実行前）

### A-1. 接続レコードの現在状態を記録

```sql
SELECT
  id,
  company_id,
  provider,
  status,
  expires_at,
  last_refresh,
  vault_secret_id IS NOT NULL AS has_vault_secret
FROM connections
WHERE status = 'active'
ORDER BY provider, company_id;
```

**確認観点:**
- `expires_at` が現在時刻より過去であれば、トークンは失効済み（リフレッシュ対象）
- `expires_at` が現在時刻＋5分以内でも、リフレッシュ対象（5分バッファ）
- `last_refresh` が最終同期日時

### A-2. 現在のイベント件数を記録

```sql
SELECT source, COUNT(*) as event_count
FROM events
WHERE company_id IN (
  SELECT company_id FROM connections WHERE status = 'active'
)
GROUP BY source
ORDER BY source;
```

---

## 検証B: sync-connectionsの手動実行

### B-1. Edge Functionの手動invoke

Supabase Dashboard > Edge Functions > sync-connections > 「Test Function」ボタン、
またはcurlで実行:

```bash
curl -X POST \
  'https://kwpldqbnkraftaahnpev.supabase.co/functions/v1/sync-connections' \
  -H 'Authorization: Bearer <SERVICE_ROLE_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{}'
```

**期待レスポンス（正常時）:**
```json
{
  "results": [
    {
      "provider": "google_calendar",
      "company_id": "...",
      "status": "synced",
      "detail": "N events"
    }
  ]
}
```

**期待レスポンス（リフレッシュ失敗時）:**
```json
{
  "results": [
    {
      "provider": "google_calendar",
      "company_id": "...",
      "status": "skipped",
      "detail": "refresh failed: token endpoint returned 401"
    }
  ]
}
```

### B-2. レスポンスの確認観点

| status | 意味 | 次のアクション |
|--------|------|---------------|
| `synced` | リフレッシュ成功（or トークン有効）＋データ同期成功 | 検証C-1へ |
| `skipped` | リフレッシュ失敗 → reauth_required設定済み | 検証C-2へ |
| `error` | 同期中のAPI/DBエラー | Supabase Logs確認 |

---

## 検証C: After状態の確認（sync実行後）

### C-1. 陽性コントロール確認（B-s2-1: リフレッシュ成功時）

```sql
SELECT
  id,
  company_id,
  provider,
  status,
  expires_at,
  last_refresh
FROM connections
WHERE status = 'active'
ORDER BY provider, company_id;
```

**確認観点:**
- `expires_at` が **Before (A-1) より未来** に更新されていること（リフレッシュ成功の証拠）
- `last_refresh` が **現在時刻付近** に更新されていること
- `status` が `active` のままであること

```sql
-- 新しいイベントが同期されたか確認
SELECT source, COUNT(*) as event_count
FROM events
WHERE company_id IN (
  SELECT company_id FROM connections WHERE status = 'active'
)
GROUP BY source
ORDER BY source;
```

**確認観点:**
- Before (A-2) と比較して、件数が同等以上であること（過去7日分のupsert）

### C-2. 陰性コントロール確認（B-s2-2: リフレッシュ失敗時）

ユーザーが連携を解除した場合や、refresh_tokenが失効した場合に発生。

```sql
SELECT
  id,
  company_id,
  provider,
  status,
  expires_at,
  last_refresh
FROM connections
WHERE status = 'reauth_required'
ORDER BY provider, company_id;
```

**確認観点:**
- `status` が `reauth_required` に変更されていること
- 接続ページ（/connect）で「要再連携」バッジと「再接続」ボタンが表示されること

---

## 検証D: 意図的な期限切れテスト（B-s2-3）

本番で安全にテストするため、テスト用の接続レコードの `expires_at` を過去に書き換えて
sync を再実行し、リフレッシュが自動で行われることを確認する。

### D-1. テスト対象の接続IDを控える

```sql
SELECT id, provider, expires_at
FROM connections
WHERE status = 'active'
LIMIT 1;
-- → この id を <CONNECTION_ID> として使う
```

### D-2. expires_atを過去に書き換え

```sql
UPDATE connections
SET expires_at = now() - interval '1 hour'
WHERE id = '<CONNECTION_ID>';

-- 書き換え確認
SELECT id, provider, status, expires_at
FROM connections
WHERE id = '<CONNECTION_ID>';
-- 期待: expires_at が1時間前
```

### D-3. sync-connectionsを手動実行（B-1と同じ手順）

### D-4. リフレッシュ結果の確認

```sql
SELECT id, provider, status, expires_at, last_refresh
FROM connections
WHERE id = '<CONNECTION_ID>';
-- 期待:
--   status = 'active'
--   expires_at が現在時刻 + 約1時間（Googleの場合）
--   last_refresh が現在時刻付近
```

**これが成功すれば B-s2-3（期限切れ→リフレッシュ→自動更新）が本番で確認完了。**

---

## トラブルシューティング

### sync-connectionsが404を返す
→ Edge Functionがデプロイされていない。GitHub Actions deploy-functionsジョブを確認。

### pg_cronジョブが見つからない
→ 00018マイグレーションが未適用。GitHub Actions deploy-migrationsジョブを確認。
→ pg_cronまたはpg_net拡張が有効でない場合:
```sql
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
```

### Vault関数がpermission deniedを返す
→ 00017の権限設定が適用済み。service_roleキーで呼んでいることを確認。
Edge FunctionはgetSupabaseAdmin()を使っているためservice_role。

### リフレッシュが毎回失敗する
→ GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET がEdge Function環境変数に設定されているか確認:
Supabase Dashboard > Project Settings > Edge Functions > Environment Variables
