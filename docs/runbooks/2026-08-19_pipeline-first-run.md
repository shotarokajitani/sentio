# パイプライン初回手動実行 手順書（A-1）

作成: 2026-08-19 / 対象: state → sense → act の各Edge Functionを**本番で1回ずつ手動実行**し、
「どこで止まるか」を実測で確定させる。
実行者: **人間**（Supabase Dashboard）。Claudeは本番に触らない（CLAUDE.md 絶対規則）。
実行対象company: `company_id = 197f2c0e-aef8-405d-afcc-34d23c771fcd`（events 15件・calendar由来のみ）

> この手順書は**本番への書き込みを伴う**（baselines / narratives / company_summary /
> findings / delivery_log へのINSERT・UPSERT、およびメール1通の送信）。
> cron登録（A-2）は本手順書の実測結果が出るまで行わない。

---

## 0. 事前の切り分け表（**実行前に読むこと**）

STEP 1〜6 のうち **2つは失敗することが、コードとマイグレーションの突き合わせで確定している**。
「失敗＝手順ミス」と誤読しないために、想定される結果を先に固定する。
実測がこの表と食い違ったら、その差分こそが新情報である。

| STEP | Function           | 事前予測                                   | 区分         | 根拠                                                               |
| ---- | ------------------ | ------------------------------------------ | ------------ | ------------------------------------------------------------------ |
| 1    | `state-baselines`  | **HTTP 500**（列不在 / ON CONFLICT不成立） | **不具合#1** | §0.1                                                               |
| 2    | `state-narratives` | **HTTP 500**（`narratives.key` 不在）      | **不具合#2** | §0.2                                                               |
| 3    | `state-summary`    | 200 / `company_summary` 1行                | 正常         | upsert先の列が全て実在し `company_id` がPK＝ON CONFLICT成立        |
| 4    | `scan`             | 200 / `total_candidates = 0`               | **正常**     | §0.3                                                               |
| 5    | `run-sense`        | 200 / `total_findings = 0`                 | **正常**     | candidates 0件 → `investigate` は呼ばれない（LLM費用も発生しない） |
| 6    | `deliver-pulse`    | 200 / メール1通着信 / `delivery_log` 1行   | 正常         | 送信経路はスライス1で実証済み。本文は「イベント0〜数件・平常」     |

### §0.1 STEP 1 が落ちる理由（不具合#1・スキーマ不一致）

`supabase/functions/state-baselines/index.ts:61-68` は `baselines` に対して
`median` / `iqr` / `p25` / `p75` / `observation_count` を書き、
`onConflict: "company_id,metric_key"` を指定する。

`supabase/migrations/00003_create_baselines.sql` の実列は
`id / company_id / metric_key / entity_id / granularity / stats / min_obs / is_established / updated_at` のみ。

- 上記5列は**存在しない** → PostgREST が `PGRST204`（`Could not find the 'median' column`）で拒否
- かつ `(company_id, metric_key)` に**一意制約が無い**（`idx_baselines_company` は非UNIQUE）
  → 仮に列が揃っていても `42P10 there is no unique or exclusion constraint matching the ON CONFLICT specification`
- さらに `granularity` は `NOT NULL` かつ既定値なし → 挿入本文に無いため単独でも失敗する

つまり**3重に不成立**であり、「たまたま通る」経路は無い。

**正しい形は `src/state/baselines.ts` 側にある**（統計値を `stats` JSONB に入れる。`00003` と一致）。
Edge Function だけが別スキーマを前提に書かれ、`tests/unit/baselines.test.ts` は
`src/` の純関数しか検証していないため、この乖離はCIで一度も顕在化していない。
`scripts/seed-synthetic-local.ts:96-108` も Edge Function 側と同じ（存在しない）列を書いている。

### §0.2 STEP 2 が落ちる理由（不具合#2・スキーマ不一致＋設計の齟齬）

`supabase/functions/state-narratives/index.ts:22-82` は `narratives.key` /
`updated_at` / `source_event_id`（単数）を読み書きする。
`00004_create_narratives.sql` の実列は
`id / company_id / category / topic / content / confidence / source_event_ids（複数）/ last_confirmed_at / decayed_at`。
`key` も `updated_at` も `source_event_id` も**存在しない**（`42703`）。

加えて設計上の齟齬がある。**`state-narratives` は「夜間バッチ再計算」ではなく、
1件のnarrativeを upsert する単発APIである**（`key` と `content` を呼び出し側が渡す）。
`company_id` だけを渡す「パイプラインの1段」としては呼べない。
`state-baselines → state-narratives → state-summary` と一列に並べる前提は、
この時点で成り立っていない。**A-2 はこの事実を織り込んで設計すること。**

### §0.3 STEP 4 で candidates 0件が「正常」である理由

`supabase/functions/scan/index.ts` の5走査が見ているのは
`transaction`（乖離）/ `metrics.is_overdue`（期日）/ `external`+`S0`（外部着火）/
`monitor`（サイト死活）/ `communication`・`web`・`attendance`（メトリクス悪化）。

本番の15件は **すべて `event_type = 'schedule'`（`source = 'google_calendar'`）**
（`supabase/functions/sync-connections/index.ts:217-227`）。
**scan には schedule を見る走査が1本も無い。**
したがって candidates は構造的に 0 件であり、これは**データ不足であって不具合ではない**。

また `MIN_OBS = 5` の議論はこの会社では成立以前の問題である。
`state-baselines` が数えるのは `event_type = 'transaction'` の `metrics.revenue` のみで、
本番には transaction イベントが**0件**。仮に不具合#1 を直しても
`observation_count = 0` / `is_established = false` になる。**これも正常。**

### §0.4 ついでに確定した事実（今回のSTEPでは顕在化しないが記録する）

| 事実                                                                                                                                                                               | 影響                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `scan/index.ts:41-43` は `known_explanations` から `pattern, explanation` を選ぶが実列は `kind/period/source/auto`。**かつ取得結果は以降で一度も使われていない**                   | 抑制③「既知説明レジストリ」は**未実装**。scanは落ちない（エラーを握って未使用）ため静かに効いていない     |
| `investigate/index.ts:238-242` は `budget_usage` から `used, daily_limit` を選ぶが実列は `full_runs/light_runs`。エラーは無視され `budgetData = null` → `budgetExhausted` が falsy | **調査予算の上限が実質無効**。予算超過で止まる経路が現状存在しない（トラックBのコスト統制と直結）         |
| 全Edge Functionが `--no-verify-jwt` でデプロイされ（`.github/workflows/deploy.yml:82-160`）、本文の `company_id` をそのまま service_role で扱う                                    | 関数URLを知る第三者が任意 `company_id` を指定して他社データを取得・メール送信できる。**要バックログ登録** |

§0.4 の3件はいずれも**本手順書の修正範囲外**。実測結果とあわせて検収者に判断を仰ぐ。

> **2026-08-20 追記（スライスS での処遇）。上表は 2026-08-19 時点の実測記録として残す。**
> 3件とも `docs/contracts/slice-state-repair.md` の対象になり、PR #31 で以下の状態にある。
> 上表だけを読んで「今もそうなっている」と誤読しないこと。
>
> - `known_explanations` の死んだクエリ → **削除済み**（S-6-1）。抑制③が未実装である事実は
>   `docs/spec/07_open_items.md` に登録済み
> - `budget_usage` の列不一致 → **実列（`full_runs` / `light_runs`）で動くよう修正済み**（S-6-2）。
>   行が無い場合は「無制限」ではなく 0 から数える fail-closed（S-6-3）
> - `--no-verify-jwt` → **17本すべてから除去済み**（S-4）。加えて `resolveCaller` を17本に入れ、
>   ボディの `company_id` は `internal` 以外では採用しない（S-2-9 / S-4-3）。
>   **本番での 401 実測は merge → deploy の後**（S-4-2）

---

## 1. 実行方法

GitHub Actions → **invoke-function** ワークフロー → **Run workflow**。
`function_name` に対象function名、`body` に各STEPのJSON を入れて実行する。

> **2026-08-20 変更（スライスS・S-4-10）。Supabase Dashboard の Invoke / Test タブは使わない。**
>
> 理由は2つある。
>
> 1. **Test UI に service_role を選ぶ経路が無い。** Role の選択肢は Postgres（RLSバイパス）と
>    Anonymous の2つだけで、`resolveCaller` が `internal` と認める呼び出し元になれない。
>    Headers 行に `Authorization` を手入力しても、invoke はダッシュボードの**サーバ側**から
>    出るため、それが関数まで届いたかを確定できない（2026-08-19 検収者が実測）
> 2. **17本すべてから `--no-verify-jwt` を外した。** ゲートウェイでも JWT 検証が入るので、
>    「Dashboard からなら追加の認証設定は不要」という旧前提はもう成り立たない
>
> `workflow_dispatch` なら秘密は GitHub Secrets に置け、実行記録が Actions の run ログに残る。
> 前提: リポジトリ Secrets に `SUPABASE_SERVICE_ROLE_KEY` が登録されていること
> （手順: `docs/secrets-runbook.md`「service_role キーの保管先は3箇所ある」）。

SQLはすべて `docs/runbooks/2026-08-19_pipeline-first-run.sql` にある。
Dashboard → **SQL Editor** で、指定されたブロックを**ブロック単位でコピペ**して実行する。
全ブロック読み取り専用（SELECTのみ・DDL/DML/SET ROLEを含まない）。

### 記録すること（各STEP共通）

1. HTTPステータス（Actions の run ログに出る）
2. レスポンスJSON**全文**（省略しない）。
   **取得元は Supabase の Function Logs / Invocations。**
   Actions の run ログには 2xx の本文を出していない（バイト長と SHA-256 だけ）。
   成功応答は本番会社の活動データそのもので、`--no-verify-jwt` を外して閉じた漏洩経路を
   Actions のログに開き直すことになるため（2026-08-20 受入基準の訂正）。
   **非2xx は run ログに全文が出る**ので、失敗時はそちらをそのまま使う

   > **2026-08-27 追記。件数スカラーだけは run ログから取れる。**
   >
   > 上の訂正は保つ（本文は出さない）。ただし S-3-5 の受入基準
   > 「エラーなく完走し、**findings 0件**」の 0 は本文の中にしか無く、
   > 本来の取得元である Function Logs には**誰も到達できない**ことが判明した。
   > 検収者は Supabase ダッシュボードが自動操作タブで白紙になり
   > （`docs/reports/2026-08-20_現状サマリ.md` §6・2回実測）、
   > 実行側（CC）は本番 Ref への CLI 直接操作を禁じられている（CLAUDE.md 絶対規則）。
   >
   > そこで `invoke-function.yml` は 2xx 本文から**件数スカラーだけ**を抽出して出す。
   > 形は `check:allowlist`（S-5-4）と同じ **fail-closed**。
   > 出してよいキーを `scripts/extract-invoke-metrics.mjs` に列挙し、
   > **それ以外はキー名すら出さない**（除外件数だけを出す）。
   > 除外リスト方式にしないのは、新しいキーが増えた瞬間に漏れるため。
   >
   > 守りは3段ある。**キー**（allowlist 外は非出力）/ **型**（number・boolean・null
   > 以外は値を出さない）/ **深さ**（allowlist に書いた深さしか辿らない）。
   > 陰性コントロールは `tests/unit/extract-invoke-metrics.test.ts` が固定しており、
   > 予定タイトルを含む `candidates` / `immediates` / `pulse` を混ぜた応答で
   > 1文字も出力に現れないことを検証している。
   >
   > **`pulse`（メール本文の行）は allowlist に入っていない。**
   > 本文の3行を見たい場合は、従来どおり受信メールそのものを見る。

3. 直後SQLの結果グリッド
4. Function の **Logs** タブの該当行（失敗時は必須）

---

## 2. STEP 0 — 実行前スナップショット

**SQLブロック `§0`** を実行する。ここで得た件数が全STEPの「入力」側の基準になる。

確認すること:

- `events` が 15 件・全て `event_type = 'schedule'` であること
- `baselines` / `narratives` / `company_summary` / `findings` が 0 件であること
  （0でなければ過去実行の残骸。件数を控えてから進む）
- `connections.status`
  - `active` なら直近7日のカレンダーが取り込まれている前提でよい
  - `reauth_required` なら**取り込みは止まっている**。STEP 6 で「昨日 0 件」が出ても正常

---

## 3. STEP 1 — `state-baselines`

Body:

```json
{ "company_id": "197f2c0e-aef8-405d-afcc-34d23c771fcd" }
```

| 判定       | 条件                                                                       | 意味                                                               |
| ---------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 予測どおり | 500 / `error` に `median` `granularity` `ON CONFLICT` のいずれかが含まれる | **不具合#1 を実測で確定**。A-2 の前に修正PRが要る                  |
| 想定外A    | 200 / `is_established: false` / `observation_count: 0`                     | 本番のbaselinesスキーマがリポジトリと違う（Dashboard直流しの疑い） |
| 想定外B    | 200 / `is_established: true`                                               | transaction イベントが実在する。STEP 0 の件数と矛盾するので再確認  |

**SQLブロック `§1`** で `baselines` の行が増えていないことを確認する
（500 なら 0 行のまま＝期待どおり）。

---

## 4. STEP 2 — `state-narratives`

このFunctionは `company_id` だけでは呼べない（§0.2）。**最小の1件を渡して落ち方を見る。**

Body:

```json
{
  "company_id": "197f2c0e-aef8-405d-afcc-34d23c771fcd",
  "key": "a1_probe",
  "content": "A-1手動実行の疎通確認用。実データではない。",
  "source_event_id": null
}
```

| 判定       | 条件                                              | 意味                                  |
| ---------- | ------------------------------------------------- | ------------------------------------- |
| 予測どおり | 500 / `error` に `key` または `column` が含まれる | **不具合#2 を実測で確定**             |
| 想定外     | 200                                               | 本番の narratives が `00004` と異なる |

**SQLブロック `§2`** で `narratives` が 0 行のままであることを確認する。
万一 200 で1行入った場合は該当行を控えて検収者に報告する。**削除は勝手に行わない。**

---

## 5. STEP 3 — `state-summary`

Body:

```json
{ "company_id": "197f2c0e-aef8-405d-afcc-34d23c771fcd" }
```

| 判定   | 条件                          | 意味                                                            |
| ------ | ----------------------------- | --------------------------------------------------------------- |
| 正常   | 200 / `token_count` が 1 以上 | State層で唯一まともに動く段。ここが通ることが STEP 4 以降の前提 |
| 不具合 | 500                           | レスポンス全文とLogsを添えて停止。**以降のSTEPに進まない**      |

**SQLブロック `§3`** で確認すること:

- `company_summary` が 1 行
- `chapters` が5章（overview / financial / operations / people / external）
- **operations 章に「15 schedule events tracked.」相当が入っていること**
  ＝ events が summary に到達した実証
- financial / people 章が `(no ... data)` であること
  ＝ 見えていないものを見えているふりをしていない（禁じ手6）

---

## 6. STEP 4 — `scan`

Body:

```json
{ "company_id": "197f2c0e-aef8-405d-afcc-34d23c771fcd" }
```

| 判定   | 条件                                               | 意味                                                              |
| ------ | -------------------------------------------------- | ----------------------------------------------------------------- |
| 正常   | 200 / `total_candidates: 0` / `immediate_count: 0` | §0.3 のとおり。**「検知ゼロ」は正しい挙動**                       |
| 要調査 | 200 / `total_candidates > 0`                       | 15件の中に schedule 以外が混ざっている。`candidates` 全文を控える |
| 不具合 | 500                                                | `known_explanations` の列不一致が露出した可能性。Logs必須         |

`scan` は**DBに何も書かない**（候補をレスポンスで返すだけ）。直後SQLは不要。

---

## 7. STEP 5 — `run-sense`

Body:

```json
{ "company_id": "197f2c0e-aef8-405d-afcc-34d23c771fcd" }
```

| 判定   | 条件                                                                       | 意味                                                             |
| ------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 正常   | 200 / `scan.total_candidates: 0` / `total_findings: 0` / `finding_ids: []` | `investigate` は呼ばれない。**ANTHROPIC_API_KEY は消費されない** |
| 要調査 | `total_findings > 0`                                                       | STEP 4 と矛盾する。両方のレスポンスを並べて報告                  |
| 不具合 | 502 `scan failed`                                                          | run-sense から scan への内部呼び出しが通っていない（URL/キー系） |

**SQLブロック `§5`** で `findings` が 0 行のままであることを確認する。

> **ここが「Sense層は繋がっているが、燃料が無い」ことの証拠になる。**
> パイプラインが動かない理由が「配線」なのか「材料」なのかを、この1回で分離する。

---

## 8. STEP 6 — `deliver-pulse`（メール送信あり）

Body（`email` は**検収用の受信アドレス**。生の個人アドレスは手順書に残さない）:

```json
{
  "company_id": "197f2c0e-aef8-405d-afcc-34d23c771fcd",
  "email": "shotaro.kajitani+sentio-e2e@mdc-diseno.com"
}
```

> **宛先の使い分け（2026-08-19 確定）。** 実送信を伴う経路（本手順書・S-3-2 の一気通貫）は
> 上記のプラス記法を使う。フィルタで隔離でき、本番の通知と混ざらない。
> **ローカル / CI の自動テストはここと別で、`sentio-e2e@example.com`**（RFC 2606 予約ドメイン）を使う。
> 自動テスト経路では `RESEND_API_KEY` を渡さず送信しないため到達性は要件にならず、
> 逆に**到達するアドレスを焼き込むと、キーが混入した瞬間に実メールが飛ぶ**。
> 事故時の被害をゼロにする方を採る。
> 専用エイリアス `sentio-test@mdc-diseno.com` の作成は人間作業として
> `docs/spec/07_open_items.md` に積んである（ブロッカーではない）。できたら上記を差し替える。

| 判定     | 条件                                                      | 意味                                                      |
| -------- | --------------------------------------------------------- | --------------------------------------------------------- |
| 正常     | 200 / `email_id` あり / 実際に受信箱に着信                | Act層の配線が生きている                                   |
| 設定漏れ | 500 `RESEND_API_KEY not configured` / `RESEND_FROM未設定` | Function Secrets の登録先プロジェクト取り違えを疑う       |
| 送信失敗 | 502 / `reason` に `Resend 4xx/5xx`                        | ドメイン認証の転落を疑う（`docs/checklists/env-diff.md`） |

**SQLブロック `§6`** で確認すること:

- `delivery_log` に `delivery_type = 'pulse'` の行が1件増え、`status = 'sent'`
- `content->>'email_id'` が非NULL（＝Resendの成功レスポンスを確認して記録している。`E+1`）

本文の期待値（3行）:

1. `昨日: N件のイベントを記録` — N は前日24時間に `occurred_at` を持つ events 数。**0でも正常**
2. `主な種別: schedule` または `特記事項なし`
3. `状態: 平常`（findings 0件のため。4行目は出ない）

**メールが文字化けせず読めること**もここで見る（`E+6` の再確認）。

---

## 9. 実測記入欄（実行者が埋める）

| STEP | Function             | HTTP | 予測どおりか | レスポンス要点 | 直後SQLの件数 |
| ---- | -------------------- | ---- | ------------ | -------------- | ------------- |
| 0    | （スナップショット） | —    |              |                |               |
| 1    | state-baselines      |      |              |                |               |
| 2    | state-narratives     |      |              |                |               |
| 3    | state-summary        |      |              |                |               |
| 4    | scan                 |      |              |                |               |
| 5    | run-sense            |      |              |                |               |
| 6    | deliver-pulse        |      |              |                |               |

---

## 10. この実測が A-2（cron登録）に渡す判断材料

A-2 の設計は、以下が埋まるまで確定させない。

1. **不具合#1・#2 を直してから cron に載せるのか、載せないのか。**
   壊れているFunctionをcronに登録すると、誰も気づかない静かな失敗が毎晩積み上がる
   （`00021` のヘッダに記録された既往の型）。
   **しかも cron の実行記録では気づけない**（2026-08-20 判明）。`net.http_post` は
   非同期で、cron が実行する `SELECT net.http_post(...)` は**HTTP応答を待たずに成功する**。
   関数が 401 や 500 を返しても cron 側は成功のままになる。
   実際のHTTPステータスは **`net._http_response`**（数時間で刈られる）か
   ダッシュボードの Invocations / Logs にしか無い
   （手順: `docs/runbooks/2026-08-20_delivery-idempotency.md` §3-2）
2. **`state-narratives` を「パイプラインの1段」として扱うのをやめるかどうか**（§0.2）。
   やめる場合、夜間の記銘経路は `baselines` 再計算と `summary` 再生成の2本になる
3. **依存順序の担保方法。** 現状 `state-*` と `scan` は互いに何も待たない。
   cron を時刻でずらすだけにするのか、`run-state` のようなオーケストレータを1本作るのか
4. **実行時刻。** KING OF TIME 制約（JST 8:30–10:00 / 17:30–18:30 禁止）と
   `sync-connections`（UTC 0/6/12/18）の後に State が回る順序
5. **秘密の取得方式は `00020` の Vault 方式に従う**（GUC は本番で `42501` により不可・確定事項）

---

## 11. 後始末

- STEP 2 で万一 narratives に行が入った場合は、**削除せず**検収者に報告する
- 本手順書の実測結果は、この文書の §9 に追記して残す（別ファイルを作らない）
