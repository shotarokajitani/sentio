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

## 本番public に残存する旧スキーマの処遇（人間の関門・2026-08-15）

診断キットQ1〜Q8（`docs/runbooks/2026-08-12_migration-state-diagnosis.md`）の実測で、
本番 `public` に**16テーブルが残存**していることが確定した（分岐C）。
新スキーマ12テーブルは未作成で、これらと**共存させる前提**で修復を進めている。
**削除・退避の判断は未確定。勝手に確定させない。**

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

**未確定のまま維持する点:** 旧スキーマの処遇（削除 / 退避 / 残置）そのもの。
上記はあくまで「現状が安全か」の確認であり、処遇を確定させるものではない。
