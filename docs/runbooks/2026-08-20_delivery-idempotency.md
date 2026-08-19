# 配信の冪等性 — 運用手順（`00024` / 契約 S-2-6 〜 S-2-8・S-2-10）

日付: 2026-08-20
対象: `delivery_log` の `idempotency_key` / `attempts` / `status`
実装: `supabase/functions/_shared/delivery.ts` の `deliverOnce()`

> **前提**: 送信順序は「**予約(INSERT) → 送信 → 結果でUPDATE**」。
> `sending` は「送っていない」ではなく「**送った可能性がある**」を意味する。
> だから `sending` の行は**自動で期限切れにしない**。人間が確かめて手で進める。

---

## 0. デプロイ前に本番で数えること（`00024` 適用の前提確認）

`00024` は `alert_deferred` → `alert` の移行 UPDATE を含む。該当行数は deploy ログの
`NOTICE` に出るが、**適用前に本番の実数を控えておく**（0件でも「0件だった」と記録する）。

Supabase Dashboard の SQL Editor で実行する（**本番へのCLI直接操作は禁止**。読み取りのみ）:

```sql
-- (1) alert_deferred の現存数。0件なら移行不要、1件以上なら 00024 の UPDATE が動く
select count(*) as alert_deferred_rows
  from delivery_log
 where delivery_type = 'alert_deferred';

-- (2) status の分布。00024 の CHECK は7値のみ許す。
--     ここに 7値以外が出たら 00024 は RAISE EXCEPTION でデプロイを止める（fail-closed）
select status, count(*) as rows
  from delivery_log
 group by status
 order by rows desc;

-- (3) status が NULL の行（00024 が sent に埋める）
select count(*) as null_status_rows from delivery_log where status is null;
```

### 実測記録

| 項目                    | 値         | 実施日 | 実施者 |
| ----------------------- | ---------- | ------ | ------ |
| `alert_deferred` の行数 | **未実施** |        |        |
| 7値以外の `status`      | **未実施** |        |        |
| `status is null` の行数 | **未実施** |        |        |

> **この表を埋めてからデプロイする。** (2) に7値以外が出た場合、`00024` は
> `delivery_log.status に想定外の値がある: …` で**デプロイを止める**。
> 止まったら値を確認し、7値のどれに寄せるかを決めてから `00024` に移行UPDATEを足すこと。
> 制約だけ緩めて通すのは不可（制約はあるが実態は守られていない状態になる）。

---

## 0-2. 予算日付の基準を UTC → JST に変えたことの確認（2026-08-20）

`_shared/budget.ts` の `budgetDateKey` は `toISOString().slice(0, 10)` ＝ **UTC 基準**だった。
配信の冪等キーは JST 基準（`pulse:<company_id>:<JST日付>`）なので、
**同じコードベースの中に「日次」の意味が2つ**あった（検収者指摘）。

JST に寄せた。上限は運用者（日本）が「今日はもう回さない」と読む単位であり、
配信の対象日と一致していないと突合できない。UTC 基準だと上限のリセットが
**毎朝 9時 JST** になり、1日の切れ目が配信とずれる。

実装は `_shared/jst.ts` に1本化した（`jstDateKey` / `isoWeekKey`）。
**新しく日付キーを作るときは必ずここを使う。**

### 移行の要否（デプロイ前に人間が確認）

`budget_usage.date` は DATE 型なので、既存行があると基準変更で**1日ぶんずれる**
（UTC 基準で書かれた行が、JST 基準の読み取りと噛み合わなくなる）。

Dashboard の SQL Editor で読み取り専用 SELECT を実行する:

```sql
select count(*) as budget_usage_rows from budget_usage;

-- 行がある場合は日付の分布も見る（どの範囲がずれるかの把握）
select date, count(*) as rows, sum(full_runs) as full_runs
  from budget_usage
 group by date
 order by date desc
 limit 14;
```

| 項目                  | 値         | 実施日 | 実施者 |
| --------------------- | ---------- | ------ | ------ |
| `budget_usage` の行数 | **未実施** |        |        |

**0件なら移行不要**（この表に「0件だったので移行不要」と記録して完了）。
**1件以上なら**、ずれるのは高々1日ぶんで、影響は「その日の `full_runs` が
2行に分かれて上限判定が甘くなる」こと。実害の大きさに応じて次のどちらかを選ぶ:

- 放置する（翌 JST 日から正しくなる。既存行は 10回上限に対して最大でもう10回ぶん甘くなる）
- 該当日の行を統合する移行SQLを `00025` として足す

**どちらを選んだかをこの表の下に1行残すこと。** 黙って放置しない。

---

## 1. 冪等キーの構成要素

| Function          | 冪等キー                                                            |
| ----------------- | ------------------------------------------------------------------- |
| `deliver-pulse`   | `pulse:<company_id>:<対象日 JST YYYY-MM-DD>`                        |
| `deliver-weekly`  | `weekly:<company_id>:<ISO週 YYYY-Www>`                              |
| `deliver-alert`   | `alert:<company_id>:<event_id>`                                     |
| `day0`            | `day0:<company_id>`                                                 |
| `onetap-calendar` | `onetap_calendar:<company_id>:<finding_id>:<recipient_id>:<action>` |

### `event_id` を対象IDに使える根拠

`00001_create_events.sql:5` が `event_id TEXT PRIMARY KEY`。
さらに `supabase/migrations/00001_create_events.sql:23` で `idx_events_event_id` の
UNIQUE 索引も張られている。値は `supabase/functions/_shared/event-id.ts` の
`SHA-256(fingerprint:rowContent)` で**内容から決定的に**作られるため、
同じイベントを再取り込みしても同じ値になる（＝再採番されない）。

**CI の実DBでの確認**（`integration` ジョブのログに出る）:

```bash
psql "$SUPABASE_DB_URL" -A -t -c "
  select c.conname, c.contype, a.attname
    from pg_constraint c
    join unnest(c.conkey) k(attnum) on true
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
   where c.conrelid = 'public.events'::regclass and c.contype = 'p'"
```

期待値: `events_pkey|p|event_id`

> **実測記録**: 未実施（CI の integration ジョブで取得したら、出力をここに貼る）。
> 「ingest が採番するから一意のはず」は根拠として弱いので、実物の制約名で示す。

---

## 2. `sending` のまま固まった行の復旧

**関数が送信の途中で落ちると、行は `sending` のまま残る。**
これは不具合ではなく設計（送ったか分からないので fail-closed）。
自動で `failed` に落として再送すると、**実際には届いていたときに2通目が出る。**

### 2-1. 固まっている行を見つける

```sql
select id, company_id, delivery_type, status, attempts,
       idempotency_key, created_at, content->>'email_id' as email_id
  from delivery_log
 where status = 'sending'
   and created_at < now() - interval '30 minutes'
 order by created_at;
```

### 2-2. 実際に届いたかを Resend 側で確かめる

1. `content->>'email_id'` が**入っている** → Resend は成功レスポンスを返している。
   **届いている**とみなし、2-3a へ
2. `email_id` が **NULL** → 送信の成否が Sentio 側に残っていない。
   Resend のダッシュボード（Logs）で、`created_at` 前後・宛先・件名で該当メールを探す
   - 見つかった → 2-3a（届いている）
   - 見つからない → 2-3b（届いていない）

> **判断がつかない場合は 2-3a（届いた扱い）にする。** 未送信より二重送信のほうが害が大きい。
> 利用者に送り直す必要があると判断したら、その判断を人間の名前で記録してから 2-3b にする。

### 2-3a. 届いていた場合 — `sent` に確定させる

```sql
update delivery_log
   set status = 'sent',
       sent_at = coalesce(sent_at, created_at),
       content = content || jsonb_build_object('recovered_by', 'manual', 'recovered_at', now())
 where id = '<対象のid>'
   and status = 'sending';
```

### 2-3b. 届いていなかった場合 — `failed` に落として再試行を許す

```sql
update delivery_log
   set status = 'failed',
       content = content || jsonb_build_object('recovered_by', 'manual',
                                               'recovered_reason', 'resend に該当なし')
 where id = '<対象のid>'
   and status = 'sending';
```

`failed` にすると `attempts < 3` の間だけ再送できる。再送は §4 の手動実行から行う。

### 2-4. 再試行の上限に達した行

```sql
select id, company_id, delivery_type, attempts, idempotency_key, content->>'send_error'
  from delivery_log
 where status = 'failed' and attempts >= 3;
```

上限に達すると Function は**送信せず 500 を返す**（`reason: 再試行の上限に達したため送信しない`）。
黙って止まらないので、ここに出た行は原因（`send_error`）を直してから
`attempts = 0` に戻すか、行を削除して再実行する。**原因を直さずに `attempts` だけ戻さない。**

---

## 3. cron 追加時の点検（対象期間の境界）

**2026-08-20 時点の実測**: `supabase/migrations/` に定義されている `cron.schedule` は
`sync-connections`（`0 0,6,12,18 * * *` UTC ＝ JST 9/15/21/3時）**1本のみ**。
**`deliver-pulse` / `deliver-weekly` の cron はまだ存在しない。**

配信の cron を追加するときは、以下を必ず確かめる。

1. **JST 0時をまたぐ時刻を避ける。** 導出（`target_date` 未指定時）は
   「JSTの前日」なので、JST 23:58 の実行と 00:02 の再実行で1日ずれる
2. 避けられない場合は **`target_date` / `target_week` の明示指定を必須**にする
3. cron の時刻を変えたら、**±5分の再実行で導出日が変わらないこと**をここに実測で記録する

| 対象               | cron（UTC）         | JST         | 0時境界からの余裕      | 実測日     |
| ------------------ | ------------------- | ----------- | ---------------------- | ---------- |
| `sync-connections` | `0 0,6,12,18 * * *` | 9/15/21/3時 | 対象外（配信ではない） | 2026-08-20 |
| `deliver-pulse`    | **未設定**          | —           | —                      | —          |
| `deliver-weekly`   | **未設定**          | —           | —                      | —          |

---

## 4. 手動での再送（明示指定で厳密に冪等にする）

再送は**対象期間を明示して**行う。導出に任せると、実行時刻によって別キーになり、
「再送したつもりが新しい配信になる」が起きる。

```json
// deliver-pulse
{
  "company_id": "<uuid>",
  "email": "shotaro.kajitani+sentio-e2e@mdc-diseno.com",
  "target_date": "2026-08-19"
}

// deliver-weekly
{
  "company_id": "<uuid>",
  "email": "shotaro.kajitani+sentio-e2e@mdc-diseno.com",
  "target_week": "2026-W34"
}
```

呼び出し経路は S-4-10 の `workflow_dispatch`（Actions の run ログに実行記録が残る）。
Supabase Dashboard の Test UI は前提にしない。

### 応答の読み方

| HTTP | `status`   | `email_sent` | 意味                                                      |
| ---- | ---------- | ------------ | --------------------------------------------------------- |
| 200  | `ok`       | `true`       | 送信成功                                                  |
| 200  | `skipped`  | `true`       | 同じキーで**既に送信済み**。再送されなかった（正常）      |
| 200  | `skipped`  | `null`       | `sending` の行がある。**送ったか分からない**（§2 へ）     |
| 200  | `deferred` | `false`      | 静音時間で繰り延べ                                        |
| 502  | `error`    | `false`      | 送っていない。Resend の失敗（`reason` を見る）            |
| 500  | `error`    | **`true`**   | **メールは出た。**記録だけ失敗（再送してはいけない。§2a） |
| 500  | `error`    | `false`      | 再試行上限、または `RESEND_*` 未設定                      |

> **`email_sent` を必ず見ること。** HTTP が 5xx でも `email_sent: true` なら
> **メールは出ている**。ここを見ずに「失敗したから再実行」と判断すると2通目が出る。

---

## 5. テストから実送信しえないことの担保（S-2-10）

- `vitest.config.ts` がテストプロセスから `RESEND_API_KEY` / `RESEND_FROM` を
  **無条件に削除**する（`.env` 由来もシェルの export も落とす）
- CI の `verify` ジョブが `printenv` で「そもそも渡していない」ことを実測する
- 自動テストの宛先は `sentio-e2e@example.com`（RFC 2606 予約ドメイン）。
  **到達するアドレスを焼き込まない**
- `tests/unit/test-recipients.test.ts` が `tests/` `supabase/functions/` `scripts/` を走査し、
  許可されていない実アドレスの混入を機械的に止める
