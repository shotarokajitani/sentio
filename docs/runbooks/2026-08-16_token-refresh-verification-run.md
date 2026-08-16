# トークンリフレッシュ本番実測 — 検証A〜D 実行手順（統合版）

実行者: **人間**（関門3「本番実測の最終確認」）
前提: `2026-08-15_token-refresh-prereq-check.sql` の **seq 1〜8 が OK**（2026-08-15 16:13 UTC 達成済み）
正本の解説: `2026-08-07_token-refresh-verification.md`（背景・実装挙動の根拠はそちら）

> ## 実施記録
>
> **2026-08-16: STEP 1実行 → `connections` 0件でSTOP。**
> 検証A〜Dは**初回OAuth連携作成後に実施**する（繰り延べ確定・検収者判断）。
> `connections` は全ステータス0件で、STEP 1 の SUMMARY が
> `STOP: activeな接続が0件` を返した。前提不足であり、実装の問題ではない。
>
> **cron疎通は別経路で実証済み。** `cron.job_run_details` が
> **4回発火（UTC 18/00/06/12時）・失敗0件・`last_message = "1 row"`**（`net.http_post` 正常）。
> ⇒ `00020` の「Vaultから秘密取得 → Edge Function 呼び出し」が本番で4回連続成功しており、
> prereq-check の seq 9 相当は **OK**。
>
> したがって**未確認として残るのは「実際のトークンでリフレッシュが起きるか」だけ**
> （B-s2-1 / B-s2-2 / B-s2-3）。連携が1件でも作られたら本書のSTEP 1から再開する。

本書は**実行順に必要なものだけ**を並べた作業用。読み取り専用から始まり、
書き込みは **STEP 3 の1文のみ**。

---

## 最初に押さえること（ここを誤ると結果を読み違える）

`sync-connections` は **`Date.now() + 5分 >= expires_at` のときだけ**リフレッシュする
（`EXPIRY_BUFFER_MS = 5 * 60 * 1000`）。

| 条件                                     | リフレッシュ | `expires_at` | `last_refresh` | APIレスポンス |
| ---------------------------------------- | ------------ | ------------ | -------------- | ------------- |
| `expires_at` が「現在＋5分」より未来     | **行わない** | **動かない** | 現在時刻に更新 | `synced`      |
| `expires_at` が「現在＋5分」以内 or NULL | 行う         | 未来へ更新   | 現在時刻に更新 | `synced`      |
| リフレッシュ失敗                         | 行う→失敗    | 動かない     | 動かない       | `skipped`     |

**したがって:**

- **`expires_at` が動かない＝故障ではない。** トークンが有効なら動かないのが正常
- APIレスポンスの `synced` は**リフレッシュの有無を区別しない**。
  レスポンスだけでリフレッシュ成功を主張してはいけない
- **`expires_at` の前進を実証できるのは STEP 3〜4（検証D）だけ**

---

## STEP 1 — 対象選定と実行可否の判定（読み取り専用・1回コピペ）

先頭の `SUMMARY` 行が次にやることを指示する。以降の行が接続ごとの明細。

```sql
WITH conn AS (
  SELECT id, company_id, provider, status, expires_at, last_refresh, vault_secret_id
  FROM connections
  WHERE status = 'active'
),
detail AS (
  SELECT
    'CONNECTION'                        AS row_kind,
    id::text                            AS connection_id,
    provider::text                      AS provider,
    expires_at::text                    AS expires_at,
    last_refresh::text                  AS last_refresh,
    (vault_secret_id IS NOT NULL)::text AS has_vault_secret,
    (expires_at IS NULL OR expires_at <= now() + interval '5 minutes')::text AS will_refresh,
    CASE
      WHEN vault_secret_id IS NULL
        THEN 'SKIP: Vault未登録 — リフレッシュ不能。検証対象外'
      WHEN expires_at IS NULL OR expires_at <= now() + interval '5 minutes'
        THEN 'PLAN-C: このままsyncすれば expires_at が動く'
      ELSE 'PLAN-D: トークン有効 — STEP 3(検証D)でのみ実証可能'
    END                                 AS plan
  FROM conn
),
summary AS (
  SELECT
    'SUMMARY'                                                       AS row_kind,
    format('active=%s / refreshable=%s / will_refresh=%s',
      (SELECT count(*) FROM conn),
      (SELECT count(*) FROM conn WHERE vault_secret_id IS NOT NULL),
      (SELECT count(*) FROM conn WHERE vault_secret_id IS NOT NULL
         AND (expires_at IS NULL OR expires_at <= now() + interval '5 minutes'))
    )                                                               AS connection_id,
    '-'::text AS provider, '-'::text AS expires_at, '-'::text AS last_refresh,
    '-'::text AS has_vault_secret, '-'::text AS will_refresh,
    CASE
      WHEN (SELECT count(*) FROM conn) = 0
        THEN 'STOP: activeな接続が0件。検証A〜Dは実行できない（先に /connect で連携が必要）'
      WHEN (SELECT count(*) FROM conn WHERE vault_secret_id IS NOT NULL) = 0
        THEN 'STOP: Vault登録済みの接続が0件。リフレッシュ不能'
      WHEN (SELECT count(*) FROM conn WHERE vault_secret_id IS NOT NULL
              AND (expires_at IS NULL OR expires_at <= now() + interval '5 minutes')) > 0
        THEN 'GO: STEP 2 で expires_at の前進が観測できる。確定は STEP 3〜4'
      ELSE 'GO: 全接続が有効期限内。STEP 2 は完走確認のみ。実証は STEP 3〜4 で行う'
    END                                                             AS plan
)
SELECT * FROM summary
UNION ALL
SELECT * FROM detail
ORDER BY row_kind DESC, provider, connection_id;
```

**この出力をそのまま保存する**（after比較の基準）。
`SUMMARY` が `STOP:` なら**ここで終了**し、その旨を報告すること。
`GO:` なら、明細から `has_vault_secret = true` の1行を選び、その `connection_id` を
以降 `<CONNECTION_ID>` として使う。

---

## STEP 2 — sync-connections を手動実行し、完走を確認する（検証B・C）

### 2-1. 実行

Dashboard > Edge Functions > `sync-connections` > **Test Function**（body は `{}`）。
または:

```bash
curl -X POST \
  'https://<project-ref>.supabase.co/functions/v1/sync-connections' \
  -H 'Authorization: Bearer <SERVICE_ROLE_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{}'
```

> 秘密の実値をチャット・コミット・ログに貼らないこと。

**レスポンスの読み方:**

| `status`  | 意味                                          | 次                        |
| --------- | --------------------------------------------- | ------------------------- |
| `synced`  | 同期成功。**リフレッシュ有無は区別されない**  | 2-2へ                     |
| `skipped` | リフレッシュ失敗 → `reauth_required` 設定済み | 2-2で確認（B-s2-2の実証） |
| `error`   | 同期中のAPI/DBエラー                          | Edge Function Logs を確認 |

### 2-2. 直後の状態を確認（読み取り専用・1回コピペ）

```sql
SELECT
  id::text                                        AS connection_id,
  provider,
  status,
  expires_at,
  last_refresh,
  (last_refresh > now() - interval '10 minutes')  AS refreshed_just_now,
  (expires_at > now())                            AS token_valid_now,
  CASE
    WHEN status = 'reauth_required'
      THEN 'B-s2-2実証: リフレッシュ失敗 → fail-closed動作は正常'
    WHEN last_refresh > now() - interval '10 minutes' AND status = 'active'
      THEN 'OK: syncがこの接続を処理した（expires_atが不変でも正常）'
    ELSE 'NG: syncがこの接続に触れていない — Edge Function Logs を確認'
  END                                             AS verdict,
  now()                                           AS checked_at
FROM connections
WHERE status IN ('active', 'reauth_required')
ORDER BY provider, id;
```

**`refreshed_just_now = true` が必須。** これが sync がこの接続を処理した証拠。

`expires_at` は STEP 1 で `will_refresh = true` だった行だけが前進する。
`will_refresh = false` だった行が**動かないのは正常**。

> ここまでで確定するのは「syncが完走した」ことまで。
> **B-s2-1 / B-s2-3 の実証には STEP 3〜4 が必要。**

---

## STEP 3 — センチネル値に書き換える（検証D・**唯一の書き込み**）

> ⚠️ **本番データを書き換える。実行前に必ず読むこと。**
>
> - `refresh_token` が失効していた場合、この操作で対象接続は `reauth_required` に落ちる
>   （＝そのユーザーは再連携が必要になる）。実装通りの fail-closed 動作だが、
>   **実ユーザーの接続ではなく検証用の接続で行うことが望ましい**
> - STEP 1 の出力（`expires_at` の原値）を控えてあること
> - **本番へのCLI直接操作は絶対規則で禁止。必ず Dashboard > SQL Editor から実行する**

`2000-01-01` という**判別可能なセンチネル値**を入れる。こうすると STEP 4 の
after 側だけで合否が閉じ、before値を覚えておく必要がなくなる。

```sql
UPDATE connections
SET expires_at = '2000-01-01T00:00:00+00'::timestamptz
WHERE id = '<CONNECTION_ID>'
RETURNING id, provider, status, expires_at, last_refresh;
-- 期待: expires_at = 2000-01-01 00:00:00+00（RETURNINGでそのまま確認できる）
```

書き換えたら **STEP 2-1 と同じ手順で sync-connections をもう一度実行する。**

---

## STEP 4 — 判定（読み取り専用・このクエリ単独で合否が出る）

```sql
SELECT
  id::text AS connection_id,
  provider,
  status,
  expires_at,
  last_refresh,
  (expires_at <> '2000-01-01T00:00:00+00'::timestamptz) AS expires_at_changed,
  (expires_at > now())                                  AS token_valid_now,
  (last_refresh > now() - interval '10 minutes')        AS refreshed_just_now,
  (status = 'active')                                   AS still_active,
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
| `token_valid_now`    | `true`（Googleなら現在＋約1時間）                        |
| `refreshed_just_now` | `true`                                                   |
| `still_active`       | `true`                                                   |
| `verdict`            | `PASS: B-s2-1 / B-s2-3 実証完了`                         |

`verdict = PASS` で **B-s2-1（リフレッシュ成功で expires_at 前進）** と
**B-s2-3（期限切れ→自動リフレッシュ）** の本番確認が完了。

`status = 'reauth_required'` になった場合は **B-s2-2（fail-closed）** の実証。
併せて `/connect` に「要再連携」バッジと「再接続」ボタンが出ることを目視確認する。

---

## STEP 5 — 後始末

`verdict = PASS` の場合、`expires_at` は正しい未来値に更新済みなので**戻す必要はない**。

`reauth_required` に落ちた場合のみ、対象ユーザーに再連携が必要になる。
検証用接続でなく実ユーザー接続で起きた場合は、その旨を記録して連絡すること。

---

## 切り分け表（FAIL時）

| 症状                                                          | 想定原因                         | 確認先                                                 |
| ------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------ |
| STEP 1 が `STOP: activeな接続が0件`                           | 本番にOAuth連携が1件も無い       | `/connect` から連携を作る                              |
| STEP 1 明細に `SKIP: Vault未登録` しか無い                    | `vault_secret_id` が入っていない | 連携フローのVault保存処理                              |
| STEP 2-2 で `refreshed_just_now = false`                      | syncがその接続を処理していない   | Edge Function Logs                                     |
| STEP 4 で `expires_at_changed = false` かつ `status = active` | リフレッシュ判定に入らなかった   | センチネル書き換えが効いているか（STEP 3のRETURNING）  |
| `status = reauth_required`                                    | `refresh_token` 失効 or 連携解除 | 想定内。B-s2-2の実証として記録                         |
| レスポンスが `error`                                          | API/DBエラー                     | Edge Function Logs                                     |
| 404                                                           | function 未デプロイ              | deploy run 31894108206 で17/17 success 済み。URLを確認 |

---

## 報告してほしい出力

1. STEP 1 の全行（`SUMMARY` 含む）
2. STEP 2-1 のレスポンス JSON と STEP 2-2 の全行
3. STEP 3 の `RETURNING` 出力
4. STEP 4 の全行（特に `verdict`）

秘密の実値は含めないこと。上記クエリは設計上、トークン・鍵の値を返さない。
