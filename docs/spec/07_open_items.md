# 07 未確定・要確認キュー（勝手に確定させない）

| 日付       | セッション | 変更概要                           |
| ---------- | ---------- | ---------------------------------- |
| 2026-07-23 | #01        | セッション#01由来の未確定3項目追加 |

## 事業判断待ち（人間）

- プラン具体値（原則のみ確定: 体験×調査予算×Finding属性範囲で切る。「連携数課金」は禁止）
  前提条件（禁じ手9・確定）: 機構の2分——【担保＝全プラン標準】3点開示/透明性ページ/本文非取得/
  カバレッジ・鮮度・確度の正直表示/証拠遡及/ケア文脈制限/勝手に送らない/fail-closed/進行中損失の即時通知
  【価値＝課金軸】調査予算/「Sentioに聞く」/月次レーダー/Finding属性範囲/非損失系の即時性
  （下位プランは週次集約で必ず届く＝隠さない、遅く届くだけ）
- spec/10 暫定A/B/Cの承認
- オンボーダー採算モデル（初期10〜30社は獲得コストとして許容、以降の設計）
- Phase3 横断パターンの匿名化設計（法務含む）
- パターンE・F（チャット非依存シグナル）の閾値・検出ロジック詳細（→03。2026-07-23 #01で検出元対応表まで確定済み）
- Microsoft 365コネクタの詳細仕様（指示書 #02 の調査結果待ち。→01）
- 価格軸のQuestion頻度設計の確定（カバレッジ軸は不成立。→04）

## 規約・API要確認

- 勤怠（KOT・ジョブカン・freee人事労務）の外部利用可否【優先度先頭・個人沈黙シグナルの解禁条件のため】
- Google Workspaceドメイン委任の審査要件
- 取引先実名のFinding内露出範囲（共有・転送時）
- Resend差出人のsentio-ai.jp本番化（SPF/DKIM）
- Chatworkの過去メッセージ取得可否 / freee口座明細スコープと規約 / Square等POSのAPI・規約
- 人流オープンデータの二次利用条件 / 気象データ商用条件 / LINE公式のinsight API
- GBP API: Lauda側の実地知見で要件確定（2026-07-02）——Basic API Access申請が必須（api_defaultフォーム）、
  申請者自身の検証済み・60日以上アクティブなGBP保有が条件（ディセーノGBPはクリア済み）、提出はGBPオーナー権限アカウント、
  承認判定はクォータ0/300 QPM。承認はGCPプロジェクト単位のため、SentioがLaudaの申請済みプロジェクト（reply-ai）を
  共用するか別プロジェクトで申請するかは設計判断（要確認）
- Instagramレート制限がアプリ単位かアカウント単位か
- SmartHR（Plusアプリ登録）・Jobcan（DONUTS社NDA）・MF勤怠の外部利用可否（既存キュー）
- Supabaseプレビューブランチでのcron/secrets/Vault再現範囲

## 申請キュー（リードタイム＝クリティカルパス）

Google審査（進行中・継続）→ Slack Marketplace → Metaアプリ審査（Instagram）→ GBP利用申請。
Gmail CASA・GBPの実装はフェーズ2。BOJ APIは本番公開時にpost.rsd17@boj.or.jpへ通知＋クレジット表示。

## 既存資産の扱い（スライス1契約で切り分け提示）

Stripe本番・認証・ドメイン・Resend・Sentry・登録済みSecretsは流用。旧Edge Functions/スキーマは凍結→新設計で置換。

## OAuth同意画面を本番公開するか（Google審査の要否・2026-08-18 登録）

現在の同意画面は **テスト中（外部）**、テストユーザーは
`shotaro.kajitani@mdc-diseno.com` の1名のみ。

**この設定の直接の帰結: refresh_token が7日で失効する。**

> **2026-08-18 更新。** ここに書いていた検証用接続（2026-08-18 04:41 UTC 作成・
> 2026-08-25 頃に失効見込み）は、スライスA本番切替の手順4で**削除済み**。
> 現在の接続は A-1 実測で作り直した `985e6672…`（company
> `197f2c0e-aef8-405d-afcc-34d23c771fcd` / `active`）**1件のみ**で、
> 7日の時計はこちらの連携時刻から数え直しになる。正確な時刻は
> `select last_refresh, expires_at from connections` で確認すること
> （`connections` に `created_at` は無い）。
> 失効すると cron 実行で `status = reauth_required` に落ちる。

- 検証目的では問題ない（B-s2-2 の自然な本番実証として使える）
- **実ユーザーを1社でも迎えるなら成立しない。** 7日ごとに再連携を強いることになる

### 判断が要ること

1. **本番公開（In production）に切り替えるか** — 切り替えれば refresh_token は
   長期有効になる。ただし `calendar.readonly` は Google の**制限付きスコープ**にあたり、
   公開には**審査（およびスコープによっては年次のセキュリティ評価）**が必要になる可能性が高い。
   リードタイムが読めないため、申請キュー（本ファイル別項）と同じ扱いで早めに着手するか判断が要る
2. 審査を通さない場合の代替 — テストユーザー枠（最大100名）での運用に留めるか、
   別の連携方式にするか

**関連する既存項目**: 本ファイル「申請キュー」の Google審査（進行中・継続）。
同一の審査枠で扱えるのか、別申請が要るのかは未確認。

---

## /connect スライスで顕在化した2件（2026-08-18 登録）

### 1. `/api/connections` の未認証アクセス — **クローズ済み（2026-08-18、スライスA）**

**状態: 解消。** 認証スライス（`docs/contracts/slice-auth-ui.md` A-2）で塞いだ。

当時の指摘: `src/app/api/connections/route.ts` は認証を持たず、`company_id` をクエリパラメータで
受け取り、**service_role キー**で `connections` と `events` を読んでいた。
RLS をバイパスするため、company_id を知る／推測できる第三者が
任意の会社の接続状態とイベント件数を取得できた。

対処:

- `GET /api/connections` は引数を取らなくなった。company_id をクエリパラメータで受け取る経路が
  構造的に存在しない。company_id はセッション（`auth.uid()`）から導出する
- service_role をやめ、anon key ＋ ユーザーセッションのクライアントで読む。
  越境はアプリだけでなく RLS でも止まる（二重化）
- 未認証は 401

**調査で判明した追加分**: 同じ「クライアント供給の company_id を無検証で信用する」形は
`/api/connections` だけでなく5本あった。読み取りだけでなく**他社への書き込み**も通っていた。
いずれも同時に塞いだ。

| ルート                    | 当時の受け取り方                    | 影響                                                 |
| ------------------------- | ----------------------------------- | ---------------------------------------------------- |
| `api/connections`         | クエリparam                         | 他社の接続状態とイベント件数の読み取り               |
| `api/csv/ingest`          | JSON body                           | 他社スコープへの events 書き込み                     |
| `api/competitors/suggest` | JSON body                           | 他社スコープへの entities 書き込み                   |
| `api/auth/google`         | クエリparam を OAuth `state` に流用 | 他社への接続紐付け／state がCSRFトークンとして無機能 |
| `api/auth/freee`          | 同上                                | 同上                                                 |

OAuth の `state` は 32バイトの乱数に変え、httpOnly cookie と照合するようにした。

固定テスト: `tests/unit/connections-api-auth.test.ts`（未認証401）、
`tests/integration/connections-api.test.ts`（2ユーザー2社の実クエリによる越境不可）。

### 2. カレンダーの件名・出席者メールを `events.metrics` に保存している（製品判断）

`src/app/auth/callback/google/route.ts` の同期処理は、取り込んだ予定について
`metrics: { title, attendees }` を保存する（`sensitivity: "S1"`）。
件名の文字列と出席者のメールアドレスがそのまま DB に載る。

**両論併記（判断は人間）:**

- **保存してよい側の論拠**: allowlist のカラム名規則には抵触しない（`metrics` は
  JSONB の許可カラムで、禁止パターン `body|content|text|message|subject` は
  カラム名に対する規則）。件名はパターン検出（会議の沈黙・頻度変化）の
  精度に直結し、Sense層の質を上げる。S1 として分類済みで、RLSで会社スコープに閉じている。
- **保存すべきでない側の論拠**: 製品の担保として掲げている「**本文非取得**」に対し、
  会議の件名は実質的に本文に近い。出席者メールは個人情報であり、
  取引先の実名露出（本ファイル「事業判断待ち」の既存項目）とも地続き。
  Findingの根拠提示で件名が画面に出ると、ユーザーの期待と食い違う可能性がある。

**選択肢**: (a) 現状維持 (b) 件名をハッシュ／長さ等の派生値に置換
(c) 出席者はドメインのみ保持 (d) 件名は保持するがFinding表示には使わない

---

## ~~本番public に残存する旧スキーマの処遇~~ → **クローズ（方針A＝削除・2026-08-18 適用完了）**

> **決定: 旧スキーマ16テーブルを削除する（方針A）。2026-08-17 検収者承認。**
> **2026-08-18 に本番適用完了・最終検収合格**（deploy run 32088752964）。
> 適用後確認SQLで全行OK: 旧16件消滅 / 新12件無傷 / 想定外テーブルなし /
> cron は `sync-connections` のみ active / 履歴21件・最新 `00021`。
> 旧cronジョブ7件の実解除もこの実測で確定した。
>
> - 削除は `supabase/migrations/00021_drop_legacy_schema.sql` で実施。明示リストの
>   単一 `DROP TABLE IF EXISTS`（CASCADE不使用。理由は同ファイル内のコメント）
> - ~~バックアップは人間がJSONスナップショットで取得済み~~ →
>   **2026-08-18 訂正: 保存時の取り違えにより、バックアップは実際には取得されていなかった。**
>   削除前データは失われている（影響評価は下記「旧メールジョブ」項を参照）。
>   Supabase Pro の日次バックアップに削除前の復元ポイントが残る点のみ記録
> - 事前調査: `docs/runbooks/2026-08-17_legacy-drop-preflight.sql`
> - 適用後確認: `docs/runbooks/2026-08-17_legacy-drop-postdeploy.sql`
> - `00013` / `00014` の明示リストは**維持**する。旧テーブル回避という当初の動機は
>   解消したが、別の理由（管理外テーブルへの依存を断つ／権限の唯一の台帳）で
>   引き続き正当なため。各ファイルに追記済み
>
> **決定に至った経緯**（判断材料として残す）:
> 実測でテナント越境は無く（下表の評価1・2）、緊急性は無かった。
> それでも削除を選んだのは、共存を続ける積極的な理由が無く、
> `api_keys` が秘密をVaultでなくテーブルに保持する旧設計だったため（評価3-a）。
>
> **旧cronジョブ7件も同時に解除する**（2026-08-17 preflight 実測）。
> `daily-trial-check` / `monthly-cleanup-external-data` / `daily-expire-questions` /
> `daily-expire-signals` / `monthly-delete-expired-companies` /
> `weekly-summary-email` / `daily-onboarding-mail` が **4月から `active` のまま残存**していた。
> 解除しないままテーブルを消すと、以後ずっと静かに失敗し続ける。
> `sync-connections` は新スキーマ側なので解除しない。
>
> **旧メール系ジョブ2件の調査 → クローズ（2026-08-18・検収者判断）**:
> `weekly-summary-email` と `daily-onboarding-mail` が4月から `active` だった。
>
> バックアップJSONは**保存時の取り違えにより実際には取得されておらず、材料喪失**。
> ただし削除前実測で旧DBの実データは**テスト会社1件のみ（実ユーザーゼロ）**と確定しており、
> 仮に送信があっても宛先は開発者自身に限られる。
> **実ユーザーへの送信リスクは構造的に存在しなかった**ため、追加調査は不要と判断。
> Supabase Pro の日次バックアップに削除前の復元ポイントが残る点のみ記録する。
>
> 以下は当時の実測記録。決定の根拠として保存する。

### （記録）当時の状況

診断キットQ1〜Q8（`docs/runbooks/2026-08-12_migration-state-diagnosis.md`）の実測で、
本番 `public` に**16テーブルが残存**していることが確定した（分岐C）。
新スキーマ12テーブルは未作成で、これらと**共存させる前提**で修復を進めていた。

現状の緩和事実（Q2実測）: 16件とも `rls_enabled = true`。
`click_tokens` / `cron_job_logs` / `error_logs` は `policy_count = 0`＝ポリシー不在のため
非superuserからは全拒否（fail-closed）。
`rls_enabled = false` かつ `anon_can_select = true` の即時対応対象は**0件**。

- **旧スキーマ14件**（4月構築・`archive/legacy` 由来と対応）:
  `click_tokens` / `companies` / `competitors` / `conversations` / `cron_job_logs` /
  `external_data` / `industry_patterns` / `integrations` / `notification_logs` /
  `patterns` / `questions` / `signals` / `subscriptions` / `usage_logs`
- **想定外2件**（旧スキーマ台帳にも新スキーマにも無い）:
  `api_keys`（RLS有効・policy 1件） / `error_logs`（RLS有効・policy 0件）
  → 出所と用途が未特定。特に `api_keys` は名称上、秘密を保持している可能性があるため
  **中身の確認と処遇判断を優先する**（確認は読み取り専用SQLで列構成のみ。値は取得しない）

判断が要るのは「削除 / 別スキーマへ退避 / RLS有効のまま残置」の3択。
それまでの間、Sentioのマイグレーションは旧テーブルに**触れない**設計にしてある
（00013の検証対象・00014のGRANT対象をいずれも新スキーマ12テーブルの明示リストに限定済み）。

### ポリシー内容の実測（2026-08-15・`pg_policies` 読み取り）

**「旧ポリシー内容は未検証」という穴はこの実測で閉じた。** 13ポリシー / 13テーブル
（＋ポリシー0件が3テーブル）。

| 構成                                                              | 対象                                                                                                                                                                        | 定義                                                                                               |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| own companyスコープ・`FOR ALL`・roles=`public`・`with_check`=null | `api_keys`("own keys") / `competitors` / `conversations` / `external_data` / `integrations` / `patterns` / `questions` / `signals` / `subscriptions` / `usage_logs`（10件） | `qual = (company_id IN (SELECT companies.id FROM companies WHERE companies.user_id = auth.uid()))` |
| 同上（自テーブルが起点）                                          | `companies`("own company")                                                                                                                                                  | `qual = (user_id = auth.uid())`                                                                    |
| SELECTのみ・roles=`authenticated`                                 | `industry_patterns`（共有マスタ）                                                                                                                                           | `qual = true`。書き込みポリシー**なし**                                                            |
| SELECTのみ・roles=`authenticated`                                 | `notification_logs`                                                                                                                                                         | own companyスコープ。書き込みポリシー**なし**                                                      |
| ポリシー0件                                                       | `click_tokens` / `cron_job_logs` / `error_logs`                                                                                                                             | RLS有効かつポリシー不在＝非superuserから全拒否                                                     |

**評価:**

1. **テナント越境なし。** 全ポリシーが `auth.uid()` 起点のスコープで、`anon` は
   `auth.uid()` が NULL のため実効0行。`authenticated` の書き込みグラント（既存要因）も、
   `FOR ALL` の `with_check` が null で USING式を継承するため自社スコープに制限される。
   **実効的な越境書き込み・NULL書き込みは不可。**
2. **書き込みの実効遮断。** `industry_patterns` / `notification_logs`（書き込みポリシー不在）と
   ポリシー0件の3テーブルは、グラントがあってもRLSが全書き込みを拒否する。
3. **残る負債（緊急性なし・処遇判断の材料）:**
   - (a) `api_keys` はテナント越境こそ無いが、**秘密をVaultでなくテーブルに保持する旧設計**。
     旧スキーマ処遇判断で優先的に扱う
   - (b) 旧ポリシーは `FOR ALL` ＋ WITH CHECK暗黙継承という、新スキーマ監査で指摘され
     `00019` で修正した型と**同型**。ただし qual に NULL許容が無いため実害なし。
     旧テーブルは凍結方針のため**修正はせず、この事実の記録のみ**

~~**未確定のまま維持する点:** 旧スキーマの処遇（削除 / 退避 / 残置）そのもの。~~
→ **2026-08-17 に「削除」で確定（本節冒頭を参照）。この項目はクローズ。**

## `check:allowlist` のCI空洞 — 修正タスク（2026-08-18 登録・本PRでは修正しない）

CLAUDE.md絶対規則「S2テーブルに本文型カラムを追加しない（allowlist外カラムのマイグレーション禁止）」は、
CIジョブ `verify` の `pnpm run check:allowlist` で担保されている**建て付けになっているが、実際には担保されていない**。

**実測（run 32134357004 / job 95702233426）:** このstepの出力は
`check:allowlist — run against live DB` の**1行のみ**。`scripts/check-allowlist.ts` のCLI入口は
`console.log` だけで、実DBの `information_schema.columns` を照会していない。
純粋関数 `validateS2Columns` は `tests/unit/allowlist.test.ts` の3ケースで検証済みだが、
**その関数を実スキーマに当てる経路が存在しない**ため、allowlist外カラムが本番に入っても
CIは必ず緑になる。

### 判断が要ること

1. **どのDBに当てるか。** ローカル（`supabase start`）／CIのSupabaseサービスコンテナ（`integration`
   ジョブは既にDB接続を持ち、8ファイル44テストをskipなしで実行できている）／本番read-only の3択。
   本番Refへの直接操作はCLAUDE.md絶対規則で禁止のため、実行するならCI経由に限る
2. **どのジョブに置くか。** 現状 `verify` にあるがDB接続を持たない。`integration` 側へ移すのが素直だが、
   その場合「S2規則違反の検知」が統合テストの成否に混ざる
3. **失敗時の扱い。** allowlist違反はマイグレーションのmerge阻止条件なので、fail-closed（ジョブ失敗）とする

### 暫定の扱い

修正までの間、S2スキーマ変更は `.claude/skills/migration` の手順と schema-reviewer の
レビューだけが担保になる。**「CIが通ったからallowlistは守られている」と読んではならない。**
