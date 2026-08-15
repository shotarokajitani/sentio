# トークンリフレッシュ本番検証手順書（最終版）

実施日: 2026-08-07 / **最終版: 2026-08-15**
対象: B-s2-1 / B-s2-2 / B-s2-3 の本番実体確認
実行者: **人間**（本番実測は関門3「本番実測の最終確認」に該当する）

> **2026-08-15: 本手順書の前提はすべて満たされた。実測を開始してよい状態。**
>
> 長らく実施できなかった理由は「deployが一度も成功しておらず 00017/00018 が
> 本番に存在しなかった」こと。deploy run 31889710493（commit `c9f0e7f`）で
> `00001`〜`00019` の適用と全17functionのデプロイが成功し、この前提が解消した。
>
> 診断キットQ1〜Q8（2026-08-15実測）により、下記も確定済み:
>
> - `pg_cron` 1.6.4 / `pg_net` 0.20.0 / `supabase_vault` 0.3.1 が**すべて有効**
>   ⇒ 旧版が「トラブルシューティング」で扱っていた拡張有効化のDashboard先行作業は**不要**
> - 実測時点で Vault関数0行・`cron.job` に `sync-connections` 0行だったため、
>   §2 と §3 は「00017/00018 が効いたか」の**初回確認**として意味を持つ（形式確認ではない）

---

## 前提確認

### 1. デプロイ状態の確認

GitHub Actions の `deploy` ワークフロー実行結果を確認:

- `deploy-functions` ジョブ: sync-connections が正常にデプロイされたこと
- `deploy-migrations` ジョブ: 00017, 00018 が正常に適用されたこと

**2026-08-15 実測（確認済み・再実行不要）:**

| 項目              | 結果                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| deploy run        | [31889710493](https://github.com/shotarokajitani/sentio/actions/runs/31889710493) / commit `c9f0e7f` |
| repair step       | `Repaired migration history: [20260414183617 20260414183945] => reverted`                            |
| deploy-migrations | success — `00001`〜`00019` を適用（`00017` / `00018` を含む）                                        |
| deploy-functions  | success — 17/17 すべて success（`sync-connections` は 14:23:27→14:23:52Z）                           |

先に `docs/runbooks/2026-08-15_post-deploy-schema-verification.sql` を実行し、
新スキーマ12テーブルが `verdict = 'OK'` であることを確認してから §2 へ進むこと。

> **§2〜§4 は統合版に置き換えた（2026-08-15）。**
> `docs/runbooks/2026-08-15_token-refresh-prereq-check.sql` を**1回コピペで実行**すれば、
> §2（Vault権限）・§3（cronジョブ）・§4（GUC）が1つのグリッドで判定される。読み取り専用。
> 以下の §2〜§4 は各項目の背景と期待値の説明として残す。
>
> 特に §2 は、旧版の `SET ROLE` を使う手順を**カタログ参照（`has_function_privilege`）に
> 変更**した。旧版は読み取り専用でなく、2文目が例外で終わるため1回コピペにできず、
> `RESET ROLE` の流し忘れでセッションが権限降格したまま残る危険があった。
>
> §4 が `NG: 未設定` だった場合の設定手順は、秘密の実値を扱う**関門2**のため
> `docs/runbooks/2026-08-15_guc-setup-procedure.md` に分離した。

### 2. Vault権限の確認（SQL Editor）

**必ず1文ずつ実行すること。** 2文目は例外で終わるため、まとめて実行するとトランザクションが
abortして `RESET ROLE` が流れない。

```sql
-- ① ロールを切り替える
SET ROLE authenticated;
```

```sql
-- ② 呼び出しを試みる（失敗が期待値）
SELECT update_vault_secret(gen_random_uuid(), 'test');
-- 期待結果: ERROR: permission denied for function update_vault_secret
-- ここでエラーが出なければ 00017 のREVOKEが効いていない（要調査・本番反映やり直し）
```

```sql
-- ③ 必ず戻す
RESET ROLE;
SELECT current_user;  -- postgres に戻っていることを確認
```

### 3. pg_cronジョブの確認（SQL Editor）

```sql
SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname = 'sync-connections';
-- 期待結果: schedule = '0 0,6,12,18 * * *' / active = true のレコードが1件
```

### 4. cronジョブが参照するGUCの確認（SQL Editor）

00018のcron本文は `current_setting('app.settings.supabase_url')` と
`current_setting('app.settings.service_role_key')` を参照する。**この2つが未設定だと、
マイグレーション適用は成功するのにcron実行時だけ6時間ごとに静かに失敗し続ける。**
適用直後に必ず確認すること。

```sql
SELECT
  current_setting('app.settings.supabase_url', true)                  AS supabase_url,
  current_setting('app.settings.service_role_key', true) IS NOT NULL  AS has_service_role_key;
-- 期待結果: supabase_url が https://<project-ref>.supabase.co
--           has_service_role_key = true
-- ※ 第2引数 true により、未設定でもエラーにせずNULLを返す
-- ※ service_role_key の値そのものは絶対に表示・記録しないこと（IS NOT NULL のみ）
```

未設定だった場合は、cronの実行実績も併せて確認する:

```sql
SELECT status, return_message, start_time
FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'sync-connections')
ORDER BY start_time DESC
LIMIT 5;
-- 期待結果: status = 'succeeded'
-- 'failed' かつ return_message に unrecognized configuration parameter が出ていれば
-- GUC未設定が原因
```

---

## ⚠️ 前提: expires_at はいつ動くのか（実装準拠）

以下は `sync-connections/index.ts` および `_shared/token-refresh.ts` の実装を読んで確定した挙動。
**この前提を誤ると検証結果を読み違えるため、実行前に必ず把握すること。**

| 条件                                             | リフレッシュ | `expires_at`   | `last_refresh` | APIレスポンス |
| ------------------------------------------------ | ------------ | -------------- | -------------- | ------------- |
| `expires_at` が「現在時刻＋5分」より未来（有効） | **行わない** | **変化しない** | 現在時刻に更新 | `synced`      |
| `expires_at` が「現在時刻＋5分」以内 or NULL     | 行う         | 未来へ更新     | 現在時刻に更新 | `synced`      |
| リフレッシュ失敗                                 | 行う→失敗    | 変化しない     | 変化しない     | `skipped`     |

判定は `isTokenExpired()`（`EXPIRY_BUFFER_MS = 5 * 60 * 1000`）:
`Date.now() + 5分 >= expires_at` のときだけリフレッシュが走る。

**したがって:**

- **トークンがまだ有効な状態でsyncを実行しても `expires_at` は動かない。これは正常。**
  「`expires_at` が更新されない＝故障」ではない。
- APIレスポンスの `status` は成功時つねに `synced` であり、
  **リフレッシュが起きたかどうかを区別しない**（型に `"refreshed"` の定義はあるが、
  実装はこの値を返さない）。レスポンスだけでリフレッシュ成功を主張してはならない。
- **`expires_at` の前進を実証できるのは 検証D（意図的な期限切れテスト）のみ。**
  B-s2-1/B-s2-3の実証は検証Dを関門とする。

---

## 検証A: Before状態の記録（sync実行前）

### A-1. 接続レコードの現在状態を記録

**このクエリの出力をそのままコピーして保存すること**（After比較の基準になる）。

```sql
SELECT
  id,
  company_id,
  provider,
  status,
  expires_at,
  last_refresh,
  vault_secret_id IS NOT NULL AS has_vault_secret,
  -- リフレッシュ対象かどうかを実装と同じ5分バッファで事前判定する
  (expires_at IS NULL OR expires_at <= now() + interval '5 minutes')
    AS will_refresh,
  now() AS snapshot_taken_at
FROM connections
WHERE status = 'active'
ORDER BY provider, company_id;
```

**確認観点:**

- `will_refresh = true` の行だけが、このsyncで `expires_at` が動きうる行
- `will_refresh = false` しか無い場合、検証Cで `expires_at` は動かない。
  B-s2-1を実証したいなら**検証Dへ進むこと**
- `has_vault_secret = false` の行はリフレッシュ不能（Vault未登録）。あれば要調査

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

| status    | 意味                                               | 次のアクション    |
| --------- | -------------------------------------------------- | ----------------- |
| `synced`  | データ同期成功。**リフレッシュ有無は区別されない** | 検証C-1へ         |
| `skipped` | リフレッシュ失敗 → reauth_required設定済み         | 検証C-2へ         |
| `error`   | 同期中のAPI/DBエラー                               | Supabase Logs確認 |

> `synced` は「リフレッシュが成功した」ことを意味しない。トークンがまだ有効で
> リフレッシュを行わなかった場合も `synced` になる。リフレッシュの実証は検証Dで行う。

---

## 検証C: After状態の確認（sync実行後）

### C-1. 陽性コントロール確認（B-s2-1: リフレッシュ成功時）

**A-1 と同じ形で取得し、行ごとに突き合わせる。**

```sql
SELECT
  id,
  company_id,
  provider,
  status,
  expires_at,
  last_refresh,
  -- syncが今このレコードに触れたかを単独で判定できるようにする
  (last_refresh > now() - interval '10 minutes')        AS refreshed_just_now,
  -- リフレッシュ後ならトークンは未来に有効なはず
  (expires_at > now())                                  AS token_currently_valid,
  now() AS checked_at
FROM connections
WHERE status = 'active'
ORDER BY provider, company_id;
```

**確認観点:**

- `refreshed_just_now = true` … syncがこの接続を処理した証拠（**必須**）
- `status` が `active` のままであること
- `token_currently_valid = true` であること
- `expires_at`:
  - A-1で `will_refresh = true` だった行 … **A-1より未来に前進していること**
  - A-1で `will_refresh = false` だった行 … **A-1と同値のままで正常**。
    前進していなくても異常ではない（上の「前提」参照）

> A-1の全行が `will_refresh = false` だった場合、この検証Cは
> 「syncが正常に完走した」ことしか示さない。
> B-s2-1（リフレッシュ成功）の実証は**検証Dで行うこと**。

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

## 検証D: 意図的な期限切れテスト（B-s2-1 / B-s2-3）— **最終版 before/after 手順**

**`connections.expires_at` の更新を実証できるのはこの手順のみ。** 検証Cは
「syncが完走した」ことしか示さない（トークンが有効なら `expires_at` は動かないため）。

`expires_at` を**判別可能なセンチネル値**（2000-01-01）に書き換えてからsyncを実行する。
こうすると after 側だけで判定が完結し、before値を人間が覚えておく必要がなくなる。

> ⚠️ **本番データを書き換える手順**。実行前に以下を理解しておくこと。
>
> - `refresh_token` が失効していた場合、この操作で対象接続は `reauth_required` に落ちる
>   （＝そのユーザーは再連携が必要になる）。これは実装通りのfail-closed動作だが、
>   **実ユーザーの接続ではなく検証用の接続で行うことが望ましい**
> - D-1で取得した `expires_at` の原値を必ず控えること（D-5で戻す場合に必要）
> - 本番DBへのCLI直接操作はCLAUDE.md絶対規則により禁止。**すべてSupabase Dashboard の
>   SQL Editor から実行すること**

### D-1. Before: 対象を選び、原状を記録する

```sql
SELECT
  id,
  company_id,
  provider,
  status,
  expires_at        AS expires_at_before,
  last_refresh      AS last_refresh_before,
  vault_secret_id IS NOT NULL AS has_vault_secret,
  now()             AS before_taken_at
FROM connections
WHERE status = 'active'
  AND vault_secret_id IS NOT NULL   -- Vault未登録はリフレッシュ不能なので除外
ORDER BY provider, company_id;
```

**この出力をそのまま保存する。** 使う1行の `id` を `<CONNECTION_ID>` とする。

### D-2. expires_at をセンチネル値に書き換え

```sql
UPDATE connections
SET expires_at = '2000-01-01T00:00:00+00'::timestamptz
WHERE id = '<CONNECTION_ID>'
RETURNING id, provider, status, expires_at, last_refresh;
-- 期待: expires_at = 2000-01-01 00:00:00+00
--       （RETURNINGにより書き換え結果がそのまま確認できる）
```

### D-3. sync-connections を手動実行（検証B-1と同じ手順）

Dashboard > Edge Functions > sync-connections > Test Function、またはcurl。

対象接続について `status: "synced"` が返ること。`skipped` の場合は
`detail` のリフレッシュ失敗理由を記録し、D-4で `reauth_required` を確認する。

### D-4. After: 判定（このクエリ単独で合否が出る）

```sql
SELECT
  id,
  provider,
  status,
  expires_at,
  last_refresh,
  -- ── 合否判定 ──────────────────────────────
  (expires_at <> '2000-01-01T00:00:00+00'::timestamptz) AS expires_at_changed,
  (expires_at > now())                                  AS token_valid_now,
  (last_refresh > now() - interval '10 minutes')        AS refreshed_just_now,
  (status = 'active')                                   AS still_active,
  -- ── 総合判定 ──────────────────────────────
  CASE
    WHEN status = 'reauth_required'
      THEN 'FAIL(想定内): リフレッシュ失敗 → fail-closed動作は正常（B-s2-2の実証）'
    WHEN expires_at <> '2000-01-01T00:00:00+00'::timestamptz
     AND expires_at > now()
     AND last_refresh > now() - interval '10 minutes'
     AND status = 'active'
      THEN 'PASS: B-s2-1 / B-s2-3 実証完了'
    ELSE 'FAIL: 要調査（Edge Function Logs を確認）'
  END AS verdict,
  now() AS checked_at
FROM connections
WHERE id = '<CONNECTION_ID>';
```

**期待値:**

| 列                   | 期待                                                     |
| -------------------- | -------------------------------------------------------- |
| `expires_at_changed` | `true`（センチネルから動いた＝リフレッシュが走った証拠） |
| `token_valid_now`    | `true`（Googleなら現在時刻＋約1時間）                    |
| `refreshed_just_now` | `true`                                                   |
| `still_active`       | `true`                                                   |
| `verdict`            | `PASS: B-s2-1 / B-s2-3 実証完了`                         |

`verdict` が `PASS` であれば、**B-s2-1（リフレッシュ成功で expires_at 前進）**
および **B-s2-3（期限切れ→自動リフレッシュ）** が本番で確認完了。

`status = 'reauth_required'` になった場合は **B-s2-2（fail-closed）** の実証となる。
併せて `/connect` ページに「要再連携」バッジと「再接続」ボタンが出ることを確認する。

### D-5. 後始末

- `verdict = PASS` の場合、`expires_at` は本物のリフレッシュ結果で上書きされているため
  **手当ては不要**（D-1の原値に戻してはならない。戻すと実際の有効期限と食い違う）
- `reauth_required` に落ちた場合は、`/connect` から通常のOAuthフローで再連携する。
  SQLで `status` を手動で `active` に戻してはならない（Vaultのトークンは失効したままのため）

---

## トラブルシューティング

### sync-connectionsが404を返す

→ Edge Functionがデプロイされていない。GitHub Actions deploy-functionsジョブを確認。

### pg_cronジョブが見つからない

→ 00018マイグレーションが未適用。GitHub Actions deploy-migrationsジョブを確認。

→ **拡張の手動有効化はもう不要**（2026-08-15）。`00018` 自身が冒頭で
`CREATE EXTENSION IF NOT EXISTS pg_cron; / pg_net;` を実行するようになった。
本番では実測で3拡張とも有効（Q5）。
それでもジョブが無い場合は 00018 の適用自体を疑うこと。

### Vault関数がpermission deniedを返す

→ 00017の権限設定が適用済み。service_roleキーで呼んでいることを確認。
Edge FunctionはgetSupabaseAdmin()を使っているためservice_role。

### リフレッシュが毎回失敗する

→ GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET がEdge Function環境変数に設定されているか確認:
Supabase Dashboard > Project Settings > Edge Functions > Environment Variables
