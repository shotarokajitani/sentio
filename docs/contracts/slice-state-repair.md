# スライスS契約書 — State層修復・パイプライン一気通貫・Edge Function越境封鎖

状態: **active（2026-08-19 検収者承認。実装可）** / 起草: 2026-08-19
環境: ローカル Supabase（`supabase start`）＋ CI integration ジョブ ＋ Vercel preview / 本番実測は検収者関門
採点者: sprint-evaluator ＋ 検収者関門
位置づけ: `docs/contracts/roadmap.md` のスライス2に入る前に必要な**修復スライス**。
機能追加を含まない。既に在るものを「実際に動く」状態にすることだけを行う。

> **承認時の追記（2026-08-19）**: S-D1〜S-D5 はすべて起草者の推奨どおり承認された。
> 検収者から基準2点を追加（**S-4-2 の本番実測** / **S-4-8・S-4-9 の封鎖適用漏れ検出**）。
>
> **実装着手時の追記（2026-08-19）**: 起草時に残っていた4点が確定した。
>
> 1. **S-2 の適用範囲 = Edge Function 17本すべて。除外リストを作らない**（下記 S-2-0）
> 2. **deliver 系は除外せず、明示要件にする**（下記 S-2-6 〜 S-2-8）
> 3. **調査予算 = `full_runs` 1日3回（暫定値）。`light_runs` は上限なし・記録のみ**（下記 S-6-5）
> 4. **S-D1 解決。手動実行は `workflow_dispatch` に寄せる**（下記 S-4-10）。
>    Dashboard Test UI の Role 選択肢は Postgres（RLSバイパス）と Anonymous の2つだけで、
>    **service_role を選ぶ経路が無い**（検収者が実測）。したがって **S-4 のブロックは解けており着手可**

## 目的

**Sentio は Ingest 以外、State層から先が一度も実スキーマに対して動いたことがない。**
Edge Function は実在しない列を読み書きし、DBエラーは握りつぶされ、
関数は 200 と「空の結果」を返して正常終了する。
CIの単体テストは `src/` の純関数しか見ず、`tests/integration/pipeline.test.ts` は
名前に反して実DBにもEdge Functionにも当たらないため、この状態が緑のまま素通りしていた。
`check:allowlist` がCLI入口で1行 log を出すだけで緑になるのと**同型の空洞**が、より広い範囲で起きている。

このスライスのゴールは3つ。

1. State層の3つのFunctionが**実スキーマに対して動く**
2. **「静かに空を返す」経路を構造的に潰す**（DBエラーで失敗させる）
3. 同じ回帰を**次に起こさせない仕掛け**（実DBに当たる検証経路）をCIに常設する

加えて、パイプライン復旧と同じ面に露出している**越境の脆弱性**（`--no-verify-jwt` ＋
ボディの `company_id` を service_role でそのまま扱う）をこのスライスで塞ぐ。

## スコープ / 非スコープ

IN:

- `state-baselines` / `state-narratives` / `state-memory-packet` の実スキーマ整合
- DBエラーを握りつぶさない共通経路（fail-closed）と、その機械的担保
- `state → scan → run-sense → deliver` の一気通貫（合成会社で実証）
- Edge Function 17本への**越境封鎖の一律適用**（呼び出し元の判定。機能変更は上記6本のみ）
- 実DBに当たるスキーマ契約テストのCI常設
- `known_explanations` / `budget_usage` の列不一致の処遇（下記 S-方針3）

OUT（**今回作らない**）:

| 非スコープ                                                | 理由                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **`scan` に schedule 走査を追加すること**                 | **機能追加であって修復ではない**（検収者判断）。前提 P-5 に事実として明記するに留める |
| 抑制③（既知説明レジストリ）の検知ロジック実装             | 同上。列を直しても抑制の中身は存在しない。実装はスライス2                             |
| trend / silence scan（`slice-02` D-s2-1 / D-s2-2）        | 機能追加                                                                              |
| 調査予算のプラン別可変化（entitlement）                   | スライス5。本契約は**上限が効くこと**までで、値は定数1つ                              |
| 「Sentioに聞く」（`docs/contracts/slice-ask.md`）         | 本スライスが前提工程。契約自体を保留中（2026-08-19 検収者判断）                       |
| Evaluator の 5基準 / 6基準 drift の解消                   | 品質基準の変更であって修復ではない。`slice-ask.md` P-4 に記録済み                     |
| `ingest-*` / `day0` / `onetap-*` / `deliver-*` の機能変更 | 越境封鎖は一律に適用するが、中身は触らない                                            |

---

## 前提として確定している事実（2026-08-19 実測・検収者が独立検証済み）

### P-1 `state-baselines` は3重に不成立

`supabase/functions/state-baselines/index.ts:61-68` が `median` / `iqr` / `p25` / `p75` /
`observation_count` を書くが、`00003_create_baselines.sql` の実列は
`id / company_id / metric_key / entity_id / granularity / stats / min_obs / is_established / updated_at`。

1. 上記5列が存在しない（`PGRST204`）
2. `onConflict: "company_id,metric_key"` に対応する一意制約が無い（`idx_baselines_company` は非UNIQUE。`42P10`）
3. `granularity` が `NOT NULL` かつ既定値なしで、挿入本文に含まれていない

### P-2 `state-narratives` は列不一致に加えて「パイプラインの段」ではない

`index.ts:22-82` が使う `key` / `updated_at` / `source_event_id`（単数）はいずれも実在しない
（実列は `category / topic / source_event_ids / last_confirmed_at`。`42703`）。
さらに**1件の narrative を upsert する単発APIであり、`company_id` だけを渡して呼べない**。
`state-baselines → state-narratives → state-summary` を一列に並べる cron 設計は成り立たない。

### P-3 baselines の表現が3種類あり、正本が無い

| 場所                       | 形                                                            | DBと一致 |
| -------------------------- | ------------------------------------------------------------- | -------- |
| `00003`（実スキーマ）      | `stats` JSONB                                                 | —        |
| `src/state/baselines.ts:3` | `{ is_established, stats: { median, iqr, p25, p75, count } }` | **一致** |
| `src/sense/scanner.ts:11`  | フラットな `{ median, iqr, p25, p75, count }`                 | 不一致   |
| `state-baselines`（Edge）  | フラット（列として書く）                                      | 不一致   |

**この3者を繋ぐ変換アダプタはリポジトリ内に1つも存在しない**（`stats` の出現箇所は
`src/state/baselines.ts` と無関係なCSV処理のみ）。
`scripts/seed-synthetic-local.ts:96-108` も実在しない列を書いている。

### P-4 「静かに空」は編成器・Investigator・週次生成に共通で空いている

`state-memory-packet/index.ts` は baselines を `median, iqr` で、narratives を `updated_at` で引く。
どちらも `42703` になり、`Promise.all` の戻りの `error` を検査していないため
`(no baselines)` / `(no narratives)` を返して**正常終了する**。
編成器は `spec/02`「想起の一元化」により Investigator・週次生成・「Sentioに聞く」の共通経路なので、
**この穴は3つの機能すべてに同じく空いている。5セクション中2つが常に空。**

### P-5 calendar だけ繋がっている会社では、現状どの走査も発火しない

`scan` の走査対象は `transaction`（乖離）/ `metrics.is_overdue`（期日）/ `external`+`S0` /
`monitor` / `communication`・`web`・`attendance`（メトリクス変化）。
**schedule を見る走査は1本も無い。**
本番 `company_id = 197f2c0e-…` の events 15件はすべて `schedule`（`source = google_calendar`）。

したがって:

- **本番データでの一気通貫の到達点は「エラーなく完走し、findings 0件」までである。**
  Finding が出ることを本番で確認することはできない
- **一気通貫の受入基準は合成会社（`.claude/skills/synthetic-company`）で検証する**
- この事実は不具合ではない。schedule 走査の要否は本契約の対象外（非スコープ）

### P-6 `known_explanations` は列不一致かつ**結果が一度も使われていない**

`scan/index.ts:41-43` が `pattern, explanation` で引く（実列は `kind / period / source / auto`）。
`knownExplanations` 変数は以降のコードで**一度も参照されない**。
「静かに空」ではなく「**静かに無効**」であり、抑制③は実装として存在しない。

### P-7 調査予算の上限は fail-open で、まったく効いていない

`investigate/index.ts:238-242` が `used, daily_limit` で引く（実列は `full_runs / light_runs`。`00010`）。
エラーは無視され `budgetData = null` → `budgetExhausted` が falsy → **上限で止まる経路が存在しない**。
「行が無ければ無制限」であり、金銭リスクを伴う fail-open。

### P-8 Edge Function の正当な呼び出し元は、現時点で service_role のみ（実測）

| 呼び出し元                           | 認証                                                              |
| ------------------------------------ | ----------------------------------------------------------------- |
| pg_cron → `sync-connections`         | Vault から取得した service_role キーを Bearer                     |
| `run-sense` → `scan` / `investigate` | `SUPABASE_SERVICE_ROLE_KEY` を Bearer                             |
| **Next.js から Edge Function**       | **呼び出し箇所 0件**（`src/` 全走査で `functions/v1` の出現なし） |

一方、17本すべてが `--no-verify-jwt` でデプロイされ（`.github/workflows/deploy.yml:82-160`）、
ボディの `company_id` を service_role クライアントでそのまま扱う。
**関数URLを知る第三者が、任意の company_id を指定して他社データの取得・メール送信を行える。**

### P-9 実DBに当たるハーネスは既に在る

CI の `integration` ジョブは `supabase start` → `supabase db reset`（`00001` からの全適用）を
実行し、skip なしでテストを回している（`.github/workflows/ci.yml`）。
**新しい基盤を作る必要はない。既存ジョブに検証を足すだけで足りる。**
ただし `tests/integration/pipeline.test.ts` は `src/` の純関数へ手作りオブジェクトを渡す
**インメモリテスト**であり、実DBにもEdge Functionにも当たっていない。

---

## 修復方針の提案（根拠つき・承認対象）

### S-方針1: スキーマを正とし、コードを直す（例外は一意制約のみ）

**採用理由**: マイグレーションで列を足す方向は、`00013` のRLS検証リスト追記・
`EVENTS_ALLOWLIST`・GRANT・本番適用リスクをすべて巻き込み、面が広がる。
一方コード側は、`src/state/baselines.ts` が既に `00003` と一致する正しい形を持っている
（P-3）。**正しい実装がリポジトリ内に既にあり、Edge Function だけが逸れている。**

| 対象                                    | 修復の形                                                                                                 | マイグレーション |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------- |
| `state-baselines`                       | 統計値を `stats` JSONB に入れる。`granularity` を明示。計算は `src/state/baselines.ts` を正本として使う  | **必要**（下記） |
| `state-narratives`                      | `key` → `category` + `topic`、`source_event_id` → `source_event_ids`、`updated_at` → `last_confirmed_at` | 不要             |
| `state-memory-packet`                   | select 列を `stats` / `last_confirmed_at` に修正                                                         | 不要             |
| `src/sense/scanner.ts` の `Baseline` 型 | DB形（`stats`）からの**変換アダプタを1本作る**。フラット型は境界の内側だけで使う                         | 不要             |
| `scripts/seed-synthetic-local.ts`       | 同上（`stats` で投入）                                                                                   | 不要             |

**唯一マイグレーションが要るのは一意制約**（コード側では作れないため）。
`00023` で `baselines` に自然キーの一意索引を足す。
`spec/02` の定義「指標×エンティティ(任意)×粒度ごと」に従うと自然キーは
`(company_id, metric_key, entity_id, granularity)`。
`entity_id` が NULL を取りうるため、PostgreSQL 15 の `UNIQUE NULLS NOT DISTINCT` を使う
（`supabase/config.toml` の `major_version = 15` で利用可能）。→ **S-D2 で承認を仰ぐ**。

### S-方針2: 越境封鎖は「ゲートウェイ＋関数内判定」の二層（推奨）

3案を比較した。

**案A: `--no-verify-jwt` を外すだけ** → **単独では不十分。採用しない。**
ゲートウェイの `verify_jwt` は JWT の**署名と期限しか見ない**。
anon キーは公開値（`NEXT_PUBLIC_` でブラウザに配る前提の正当なJWT）なので、
これを付ければ検証を通る。**「JWTを持っているか」と「その会社の人か」は別問題であり、
案A は後者を1ミリも解決しない。**

**案B: 関数内で呼び出し元を判定する（本丸・推奨）**
`_shared/caller.ts` に `resolveCaller(req)` を置き、`Authorization: Bearer <token>` を分類する。

| トークン                             | 判定       | `company_id` の出所                                                     |
| ------------------------------------ | ---------- | ----------------------------------------------------------------------- |
| なし                                 | 401        | —                                                                       |
| `SUPABASE_SERVICE_ROLE_KEY` と一致   | `internal` | **ボディの `company_id` を採用**（cron・内部呼び出し）                  |
| `auth.getUser(token)` が user を返す | `user`     | **`user.id`。ボディの `company_id` は無視**（指定があり不一致なら 403） |
| それ以外（anon キー等）              | 401        | —                                                                       |

各 Function は許可する呼び出し元を宣言する（`ALLOWED_CALLERS`、**既定は `["internal"]` のみ**）。
P-8 のとおり現時点で user 経路の呼び出し元は0件なので、17本すべて既定のままで足りる。
将来「Sentioに聞く」で user 経路が要るときに、その関数だけ宣言を広げる。

**根拠**: スライスA の `getAuthedContext()`（`src/lib/auth/company.ts`）が
「company_id を呼び出し側から受け取らない」でNext.js側を固めたのと**同じ思想**を Edge 側に持ち込む。
`docs/spec/07_open_items.md` §1 のクローズを Edge Function まで広げる作業に相当する。
JWT ライブラリは不要（service_role は環境変数との一致比較、user は `auth.getUser` に委ねる）。

**案C: Edge Function を内部専用にし、外部の入口を Next.js Route Handler へ一本化** → 今回は採らない。
思想としては最も素直だが、pg_cron は Vercel の認証境界を跨げず cron 経路が Next.js を通せない。
17本分の Route Handler を作る作業も発生する。案B の user 経路で将来の必要は満たせる。

**推奨: 案B ＋ 案A の併用（二層）。** ゲートウェイで `verify_jwt` を有効化して署名・期限の
一次防御を置き、関数内の `resolveCaller` を本丸にする。
cron は service_role キー（正当なJWT）を送っているので、`verify_jwt` 有効化で壊れない。

**運用上の影響（明示・2026-08-19 解決済み）**: 封鎖後、`docs/runbooks/2026-08-19_pipeline-first-run.md`
の実行方法が変わる。**Dashboard Test UI は使えない**（Role 選択肢に service_role が無い。検収者実測）。
**手動実行は `workflow_dispatch` に寄せる。** → **S-4-10** に条件を記載。

### S-方針3: `known_explanations` と `budget_usage` は**扱いを分ける**

| 対象                 | 提案                                                          | 根拠                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `known_explanations` | **本スライスに入れる。ただし「死んだクエリを削除する」だけ**  | 結果が一度も使われていない（P-6）ので、列を直しても何も起きない。**動いていないものを動いているように見せるコードを残さない**のが本スライスの趣旨。抑制③の実装はスライス2。`spec/07` に未実装として登録する |
| `budget_usage`       | **本スライスに入れる。fail-open を fail-closed に反転させる** | 上限が効かないのは**金銭リスク**であり、パイプラインを毎日回し始める本スライスで顕在化する。「行が無ければ無制限」を廃し、行が無ければ作って0から数える。上限値は定数1つ（プラン化はスライス5）             |

---

## 受け入れ基準（全passが必要）

### S-1 スキーマ整合（State層3本＋周辺）

- **S-1-1** `state-baselines` が実スキーマに対して成功する。統計値は `stats` JSONB に入り、
  `granularity` が明示され、`onConflict` が実在する一意索引に対応する
- **S-1-2** baselines の表現が**1つに固定**される。DBの `stats` 形を正本とし、
  フラット形（`src/sense/scanner.ts`）へは**単一の変換アダプタ経由でのみ**到達する。
  変換アダプタは1本だけ存在し、テストを持つ（P-3 の3種類併存を解消する）
- **S-1-3** `state-narratives` が実スキーマに対して成功する（`category` / `topic` /
  `source_event_ids` / `last_confirmed_at`）。confidence の時間減衰と訂正時の即時減算は維持する
- **S-1-4** `scripts/seed-synthetic-local.ts` が実在する列で baselines を投入する
- **S-1-5** `state-memory-packet` が baselines と narratives を**実際に返す**。
  5セクションが埋まったパケットを返すことを実DBテストで固定する（P-4 の解消）
- **S-1-6** `00023` は再実行安全（`IF NOT EXISTS` 等）。`00013` のRLS検証リストと
  `docs/checklists/env-diff.md` の点検を通す

### S-2 「静かに空を返す」経路を潰す（本スライス最大の学び）

- **S-2-0** 適用範囲は **Edge Function 17本すべて**。**除外リストを作らない**（2026-08-19 確定）。
  ingest 系・deliver 系も含む。
  理由: 除外リストは**次に足す人が増やす対象**になり、`check:allowlist` が1行 log で緑を返すのと
  同型の空洞の芽をその場で植えることになる。時限付き除外も同じ芽を残す。
  ingest 系の握りつぶしは**データの静かな欠落**そのものなので、5xx で落ちるほうが厳密に正しい。
  deliver 系の懸念（送信済みなのに失敗を返す）は**除外ではなく S-2-6 〜 S-2-8 の明示要件で扱う**
- **S-2-1** Edge Function 内の全DBアクセスで、`error` を検査せずに `data` を使う経路が**存在しない**
- **S-2-2** DBエラーは**握りつぶさず失敗させる**。`42703` / `PGRST204` 等が起きたら
  関数は 5xx を返す。`(no baselines)` のような**既定値を返して 200 で終わらない**
- **S-2-3** **「0件」と「エラー」がレスポンスで区別できる。**
  0件は正常系として明示的に返し、エラーは異常系として返す
- **S-2-4** S-2-1 を**機械的に担保する検査がCIに存在する**。
  `const { data } = await supabase...`（`error` を受け取らない分割代入）のような
  握りつぶしパターンを検出し、検出時に fail する。
  **陽性・陰性コントロールの両方を持つ**（握りつぶしを1件仕込んで fail することを示す）
- **S-2-5** `Promise.all` で束ねたクエリでも個々の `error` が検査される
  （`state-memory-packet` / `state-summary` が該当）

#### deliver 系の明示要件（2026-08-19 追加。S-2-0 の除外に代わるもの）

握りつぶしを失敗に変えると、deliver 系だけは「**メールは出たのに 5xx**」が起こりうる。
再試行がそのまま2通目を出すと、Sentio が勝手に同じものを2回送ることになる。

- **S-2-6** DBエラーが**送信の前か後か**を区別する
  - 送信**前**のDBエラー → **メールを送らずに失敗する**（fail-closed）
  - 送信**後**のDBエラー → 失敗として返すが、**レスポンスで「送信は完了している」ことが判別できる**
- **S-2-7** `delivery_log` の書き込み順序が、**二重送信の起きない形**になっている。
  形は実装判断でよいが、**採った形とその根拠を本契約書に書く**（下記「S-2-7 で採った形」）
- **S-2-8** 二重送信が起きないことを**テストで固定する**。
  送信後のDB書き込み失敗を注入し、**再試行で2通目が出ない**ことを示す

##### S-2-7 で採った形（実装判断の記録）

**送信意図の記録 → 送信 → 結果更新** の3段にする。

1. `delivery_log` に `status = "sending"` の行を**先に** INSERT する（冪等キー付き）
2. Resend へ送信する
3. 結果で `status` を `sent` / `failed` に UPDATE する
4. 再試行時、`sending` の行が既にあれば**送信済みの可能性ありとして再送しない**

**根拠**: 現状は「送信 → `delivery_log` に INSERT」の順（`deliver-pulse/index.ts:98,127`）であり、
**送信後のDB失敗がログに何も残さない**。この状態で再試行すると、DBには痕跡が無いので
2通目が出る。順序を反転させると「送ったかどうか分からない」状態が必ずDBに残り、
**判断の材料が消えない**。`sending` を「送っていない」ではなく「**送った可能性がある**」と
解釈するのは、二重送信より未送信のほうが害が小さいという判断による
（Sentio は何も勝手に送らない。CLAUDE.md 絶対規則）。

冪等キーは既存の `_shared/event-id.ts` と同じ発想で、送信単位の自然キーから作る
（pulse: `pulse:<company_id>:<JST日付>` / alert: `alert:<company_id>:<finding_id>` /
weekly: `weekly:<company_id>:<ISO週>`）。`00024` で `delivery_log.idempotency_key` に一意索引を張る。

> **この基準群が本スライスの中心である。** 列名の修正は今日の不具合を消すだけだが、
> S-2 は「同じ形の不具合が次に入っても、静かには通らない」を作る。
> `check:allowlist` が1行 log で緑を返すのと同型の空洞を、State層から排除する。

### S-3 パイプライン一気通貫

- **S-3-1** 合成会社に対し `state-baselines → state-summary → scan → run-sense → deliver-pulse`
  が**すべて 2xx で完走**する（`state-narratives` の位置づけは S-3-4 参照）
- **S-3-2** 合成会社で `findings` にレコードが**1件以上** INSERT される
  （`slice-01` D+1 を、今度は**実DBと実Function**で満たす）
- **S-3-3** `deliver-pulse` の本文に、その回の実データ由来の件数・状態が反映される。
  `delivery_log` の `status` が実際の送信結果を反映する（`slice-01` E+4 の再確認）
- **S-3-4** `state-narratives` が「パイプラインの1段」ではないことを踏まえた構成になっている。
  夜間の記銘経路は `baselines` 再計算と `summary` 再生成の2本とし、
  narratives の upsert は**イベント駆動（dialogue 発生時）**に位置づける。
  この整理が `docs/spec/02_state.md` の記銘3経路と矛盾しないことを文書で示す
- **S-3-5** 本番データ（events 15件・全て schedule）に対しては
  **「エラーなく完走し、findings 0件」が到達点である**ことを明記した上で、本番で1回実測する（検収者関門）。
  P-5 のとおり Finding が出ないのは正常であり、これを不具合として扱わない

### S-4 Edge Function の越境封鎖

- **S-4-1** 認証情報の無いリクエストが 401 になる（17本すべて）
- **S-4-2** anon キーのみを持つリクエストが 401 になる。
  **「JWTを持っている」だけでは通らない**ことを実リクエストで固定する。
  **加えて、封鎖後の本番の実 Function URL へ認証なしでリクエストして 401 を1回実測する**
  （検収者が実行・2026-08-19 追加）。
  理由: テストが緑でも本番の実物が違った、が本スライスを生んだ学びそのものである。
  ローカルの実DBテストは**本番のゲートウェイ設定（`verify_jwt`）を再現しない**ため、
  実物での確認を基準から外さない
- **S-4-3** `internal`（service_role）以外の呼び出し元に対し、
  **ボディの `company_id` が採用されない**。user 経路では JWT 由来の company_id のみが使われる
- **S-4-4** 2社分のデータを作り、**他社 company_id を明示指定しても他社データが返らない・
  他社宛にメールが送られない**ことを実クエリテストで固定する（テストコードとして残す）
- **S-4-5** cron 経路（`sync-connections`）と内部呼び出し経路（`run-sense` → `scan` / `investigate`）が
  封鎖後も動作する。**封鎖でパイプラインを壊していない**ことを S-3-1 の完走で示す
- **S-4-6** 封鎖方式は S-方針2（案B＋A）に従う。既定の許可呼び出し元は `internal` のみ
- **S-4-7** 手動実行の手順変更を `docs/runbooks/2026-08-19_pipeline-first-run.md` に反映する
- **S-4-8** **封鎖の適用漏れを機械で検出する**（2026-08-19 追加）。
  `supabase/functions/*/index.ts` のうち、呼び出し元判定（`resolveCaller`）を通っていない
  Function が**1本でもあれば CI が fail する**。
  検査は `.github/workflows/deploy.yml` のデプロイ対象リストと突合する形を採り、
  **「デプロイされているのに封鎖されていない」を検出できること**を条件とする
  （`_shared` のようにデプロイ対象でないディレクトリは対象外）。
  S-2-4 と同じ作り（ソース走査 ＋ 陽性・陰性コントロール）でよい。
  理由: **新しい Function を足すときに `resolveCaller` を呼び忘れる未来は確実に来る。**
  そのとき静かに穴が空くのを、レビューではなく機械で止める
- **S-4-10** **手動実行は `workflow_dispatch` に寄せる**（2026-08-19・S-D1 の解決として追加）。
  Supabase Dashboard の Test UI は**前提にしない**。

  **S-D1 実測の結論（検収者）**: Test UI の Role 選択肢は Postgres（RLSバイパス）と Anonymous の
  2つだけで、**service_role を選ぶ経路が無い**。`Authorization` を Headers 行で上書きできるかは
  本番関数を実際に invoke しないと確定できず、それは人間ゲートなので設計の前提にできない。
  カスタムヘッダ方式は**呼び出し元シークレットを人間が毎回ブラウザに貼る**ことになり、
  「秘密の移送はオフライン手段のみ」の原則と相性が悪く、パネルを閉じると入力が消えて誤操作しやすい。
  `workflow_dispatch` ならシークレットは GitHub Secrets に置け、**実行記録が Actions の run ログに残る**。

  実装の条件（すべて必須）:

  1. **`deploy.yml` とは別ファイル**にする。**デプロイを一切行わない**（実行だけ）
  2. 対象関数とパラメータ（`company_id` 等）は `workflow_dispatch` の `inputs` で受ける
  3. 関数URLは既存の secrets から**組み立てる。ハードコードしない**
  4. 呼び出しは `resolveCaller` を通る**正規の呼び出し元**として扱う
  5. **テスト専用の抜け道（`testMode` 等）を作らない**
  6. **実行結果（HTTPステータスとレスポンス本文）が run ログに残る。**
     ログに残らない手動実行は検収に使えないので不可（鍵は `::add-mask::` で伏せる）

- **S-4-9** S-4-8 の検査が**陰性コントロールで実際に赤くなる**ことを示す。
  封鎖していない Function を1本仕込んで fail することを証跡付きで残す（S-5-6 と同じ規律）

### S-5 回帰を止める仕掛け（実DBに当たる検証経路）

- **S-5-1** **スキーマ契約テスト**が存在する。各 Edge Function が読み書きする列集合を
  宣言的に取り出し、実DBの `information_schema.columns` と突合する。
  列が消えた／改名されたときに**CIが赤くなる**
- **S-5-2** Edge Function を**実際に起動して実DBに当てる**テストが CI の `integration` ジョブに存在する。
  最低限 `state-baselines` / `state-narratives` / `state-summary` /
  `state-memory-packet` / `scan` / `run-sense` の6本を対象とする
- **S-5-3** `tests/integration/pipeline.test.ts` が**実DBに当たらないインメモリテスト**である事実を解消する。
  実DB版を追加するか、名前と配置を実態に合わせる。
  **`integration` と名乗って実DBに当たらないテストを残さない**
- **S-5-4** `pnpm run check:allowlist` の CLI 入口が**実DBを照会する**。
  現状は `console.log` 1行で必ず exit 0 になり、CLAUDE.md 絶対規則
  「S2テーブルに本文型カラムを追加しない」の機械的担保が存在しない。
  S-5-1 の `information_schema` ハーネスで同じ仕組みが使える（→ **S-D4** で採否を仰ぐ）
- **S-5-5** skip されたテストの**件数と対象がCIログに可視化**される。
  「env が無いから skip で緑」を作らない（`.claude/skills/gotchas` の既往）
- **S-5-6** S-5-1 / S-5-2 が**今回の不具合を実際に検出できる**ことを示す。
  修復前のコードに対して**赤くなること**を証跡付きで残す（陰性コントロール）

### S-6 `known_explanations` / `budget_usage`

- **S-6-1** `scan` から `known_explanations` の**死んだクエリを削除**する。
  抑制③が未実装である事実を `docs/spec/07_open_items.md` に登録する
- **S-6-2** `investigate` の予算チェックが実列（`full_runs` / `light_runs`）で動く
- **S-6-3** **予算の判定が fail-closed である。** `budget_usage` に行が無い場合、
  「無制限」ではなく行を作って 0 から数える。上限に達したらフルハーネスを起動しない
- **S-6-4** 予算消費が実際に記録される（起動したのに `full_runs` が増えない状態を作らない）
- **S-6-5** 上限値は定数1つ。プラン別可変化はしない（スライス5）。
  **確定値（2026-08-19）: `full_runs` = 1日3回。`light_runs` は上限なし・記録のみ。**

  | 対象         | 上限                 | 根拠                                                                                                       |
  | ------------ | -------------------- | ---------------------------------------------------------------------------------------------------------- |
  | `full_runs`  | **3回/日**           | `spec/04` の週次「Finding 0〜2件」と整合し、Day0 の獲得コスト例外（フル1回）を吸収できる                   |
  | `light_runs` | **なし**（記録のみ） | `spec/03` が「フルハーネス起動上限・超過はライトパス降格」と定めている。**ライトを絞ると降格先が無くなる** |

  **この値は暫定である。** `docs/spec/07_open_items.md` に「調査予算の値は暫定」として登録し、
  プラン階層と結び付けて確定させるのはスライス5とする。
  上限をテストのために上書きする経路は作らない（本番コードに `if (testMode)` を入れない）

### S-7 セキュリティ（固定基準・`slice-01` F と同一）

- **S-7-1** トークン・秘密がコード・イベント・ログ・テストフィクスチャに存在しない
- **S-7-2** 新テーブルを作る場合は RLS ポリシーとセットで作り、`00013` の検証リストに追記する
  （追記漏れはエラーにならず静かに全公開になる）
- **S-7-3** gitleaks 検出ゼロ
- **S-7-4** `service_role` キーの比較経路で、キーがログ・エラーメッセージに出ない

---

## 検収者の判断（**2026-08-19 全件承認済み**）

推奨どおり全件承認された。以下は確定事項であり、実装はこの表に従う。

| ID       | 論点                                                                                                                         | 確定した判断                                                                                                                                                                                                                  |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S-D1** | 越境封鎖後、**Dashboard からの手動実行をどう担保するか**（service_role キーをヘッダに入れる運用を許すか）                    | **解決（2026-08-19 実測済み）。`workflow_dispatch` に寄せる。Dashboard Test UI は前提にしない**（Role 選択肢が Postgres / Anonymous のみで service_role 経路が無い）。条件は **S-4-10**。**S-4 のブロックは解けており着手可** |
| **S-D2** | `baselines` の一意索引の自然キー。`(company_id, metric_key, entity_id, granularity)` を `UNIQUE NULLS NOT DISTINCT` でよいか | **承認**。`spec/02` の「指標×エンティティ(任意)×粒度」に一致し、PG15 で `entity_id IS NULL` の重複も防げる                                                                                                                    |
| **S-D3** | `known_explanations` の死んだクエリを**削除**する案でよいか（列を直して残す案もある）                                        | **承認（削除）**。使われていないコードを「直して残す」と、実装済みに見えてしまう                                                                                                                                              |
| **S-D4** | `check:allowlist` の実装（S-5-4）を本スライスに含めてよいか                                                                  | **承認（含める）**。S-5-1 のハーネスでほぼ追加コストなく塞げる。絶対規則の唯一の機械的担保が空洞のまま修復スライスを閉じたくない                                                                                              |
| **S-D5** | 本番での S-3-5 実測を、本スライスの merge 前に置くか後に置くか                                                               | **承認**。後（merge → deploy → 本番実測 → 記録）。本番反映はCI/CDのみという絶対規則に従うため                                                                                                                                 |

---

## 検証と停止点

- CI全緑（`pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm run check:allowlist` /
  `pnpm run eval:engine`）＋ `integration` ジョブ緑 ＋ Vercel Preview 成功。
  push後は GitHub Actions と Vercel チェックの両方を完了まで自律監視する
- **TDD**: S-1（スキーマ整合）・S-2（握りつぶし検出）・S-4（越境）・S-5（回帰検出）は
  **テスト先行**。特に S-5-6（修復前のコードで赤くなること）は、
  修復コードを書く前に**先に赤を確認して証跡を残す**
- 実装順序: **S-5（検出の仕掛け）→ S-1・S-2（修復）→ S-6 → S-4（封鎖）→ S-3（一気通貫）**。
  検出の仕掛けを先に作る理由は、修復が本当に効いたかを機械で言えるようにするため。
  逆順にすると「直した気になっている」を検証できない
- A-2（cron 登録の migration）は**本スライスの後**。壊れたFunctionを cron に載せない
- 本番実測（S-3-5）は**検収者関門**
- 進行順序: 契約承認 → plan mode → 実装 → commit → 停止。停止点を越えて先に進まない
- S-D1〜S-D5 は**2026-08-19 に全件承認済み**（上表が正）。以後この5点を論点として蒸し返さない
- **S-D1 は 2026-08-19 に実測で解決済み**（`workflow_dispatch` に寄せる。S-4-10）。
  **S-4 の実装ブロックは解けている**
- 残る**人間関門は3つ**。いずれも実装側で勝手に代替しない:

  | 関門                                               | 誰が   | いつ                       | ブロックする範囲   |
  | -------------------------------------------------- | ------ | -------------------------- | ------------------ |
  | S-5-6: 修復前の赤の確認                            | 起草者 | **S-1 / S-2 の実装より前** | **修復の着手**     |
  | S-4-2 後半: 本番の実 Function URL へ認証なしで 401 | 検収者 | merge → deploy の後        | スライスのクローズ |
  | S-3-5: 本番データでの完走（findings 0件が到達点）  | 検収者 | merge → deploy の後        | スライスのクローズ |
