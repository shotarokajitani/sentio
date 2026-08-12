# Microsoft 365 カレンダーコネクタ — 差分調査レポート

日付: 2026-07-23
種別: 調査のみ（コード変更なし）

---

## 1. サマリー

既存の Google カレンダー実装は OAuth→トークンVault保存→即時同期→エンベロープ変換の一本道で、約230行（OAuth開始36行＋コールバック195行）。Microsoft Graph API による Outlook 予定表コネクタの実装規模は **Google 実装の約1.2〜1.4倍** と見積もる。増分の主因は以下の3点:

1. **トークンリフレッシュの実装が必須**（Googleでは未実装だが、MSはアクセストークン1時間・リフレッシュトークン90日と短く、放置不可）
2. **Delta Query（差分同期）** への対応が実用上必要（Google側は全件取得250件上限のままだが、MS側は差分同期が標準）
3. **マルチテナント対応**の設計判断（Azure ADテナントごとの管理者同意フロー）

ただし `connections` テーブル・`events` テーブル・Vaultヘルパー・冪等性ロジック・フロントエンド接続ハブは **大部分がそのまま共用可能** であり、新規に作り直す部分は OAuth エンドポイント群とカレンダーAPI呼び出し部分に限定される。

---

## 2. 既存 Google カレンダー実装の構造

### 2.1 OAuth 開始

| 項目 | 詳細 |
|---|---|
| ファイル | `src/app/api/auth/google/route.ts` |
| 関数 | `GET(req: NextRequest)` |
| 処理 | `company_id` を `state` に埋め込み、Google OAuth 2.0 エンドポイントへリダイレクト |
| スコープ | `https://www.googleapis.com/auth/calendar.readonly` |
| オプション | `access_type: "offline"`, `prompt: "consent"`（常にrefresh_token取得） |

### 2.2 コールバック・トークン交換・Vault保存・同期

| 項目 | 詳細 |
|---|---|
| ファイル | `src/app/auth/callback/google/route.ts` |
| 関数 | `GET(req: NextRequest)` (L7–112) |
| Step 1 | `code` → `https://oauth2.googleapis.com/token` へPOST → `access_token`, `refresh_token`, `expires_in` 取得 (L31–50) |
| Step 2 | トークンJSON → `store_vault_secret` RPC でVault保存。シークレット名: `google_calendar:{companyId}` (L54–75) |
| Step 3 | `connections` テーブルへ upsert。`provider: "google_calendar"`, `vault_secret_id`, `scopes`, `status: "active"`, `expires_at` (L77–100) |
| Step 4 | `syncCalendarEvents()` で過去12ヶ月・最大250件を即時取得 (L102–111) |

### 2.3 カレンダー同期

| 項目 | 詳細 |
|---|---|
| 関数 | `syncCalendarEvents(accessToken, companyId, supabase)` (L114–194, 同ファイル内) |
| API | `GET /calendars/primary/events?timeMin=...&timeMax=...&singleEvents=true&maxResults=250` |
| ページング | **未実装**（`nextPageToken` を追わず、250件で打ち切り） |
| 変換 | 各イベント → エンベロープ行に変換 → `events.upsert(rows, { onConflict: "event_id" })` |

### 2.4 エンベロープ形式

```
event_id:     SHA256("calendar:{company_id}:{title}:{start}:{end}")
company_id:   UUID
occurred_at:  start
period_start: start
period_end:   end
ingested_at:  now()
source:       "google_calendar"
event_type:   "schedule"
entity_refs:  []
metrics:      { title, attendees[] }
sensitivity:  "S1"
```

### 2.5 Vault・トークン管理

| 項目 | 詳細 |
|---|---|
| Vault ヘルパー | `supabase/migrations/00012_vault_helpers.sql` |
| 保存関数 | `store_vault_secret(p_name, p_secret, p_description)` — `SECURITY DEFINER`, `vault.create_secret()` 呼び出し |
| 読取関数 | `read_vault_secret(p_id)` — `vault.decrypted_secrets` から復号。`SECURITY DEFINER` |
| K分類 | **K2**（OAuth refresh_token を含む長期認証情報） |

### 2.6 トークンリフレッシュ

**未実装。** `refresh_token` はVaultに保存されているが、`expires_at` 到来時にリフレッシュする処理（cronジョブ・Edge Function）は存在しない。Google のアクセストークンは通常1時間で失効するため、初回同期以降の再同期は現状動作しない。

### 2.7 冪等性

| 項目 | 詳細 |
|---|---|
| Node版 | `crypto.createHash("sha256")` — `src/app/auth/callback/google/route.ts:164` |
| Deno版 | `crypto.subtle.digest("SHA-256")` — `supabase/functions/_shared/event-id.ts` |
| DB保証 | `events.event_id` の `UNIQUE INDEX` + `upsert({ onConflict: "event_id" })` |
| 入力 | `"calendar:{company_id}:{title}:{start}:{end}"` |

### 2.8 エラー処理

| 失敗箇所 | 挙動 |
|---|---|
| トークン交換失敗 | `?error=token_exchange_failed` へリダイレクト |
| Vault保存失敗 | `?error=vault_failed` へリダイレクト |
| connections upsert失敗 | `?error=connection_failed` へリダイレクト |
| Calendar API失敗 | `console.error` → `return 0`（例外を投げない。同期0件扱い） |
| events upsert失敗 | `console.error` → `return 0` |
| リトライ | **なし** |
| ユーザー通知 | リダイレクト先のクエリパラメータで表示 |

### 2.9 フロントエンド

| ファイル | 役割 |
|---|---|
| `src/app/connect/page.tsx:184–228` | 接続ハブ。`getConnection("google_calendar")` で接続判定。未接続→「接続」ボタン、接続済→緑バッジ＋イベント件数 |
| `src/app/register/page.tsx` | 登録フロー中の「Googleカレンダーを接続」リンク |
| `src/app/api/connections/route.ts` | `connections` + `events` カウントを返すAPI |

### 2.10 ワンタップ下書き（Act層）

| ファイル | 役割 |
|---|---|
| `supabase/functions/onetap-calendar/index.ts` | カレンダー下書き作成（`action: "create"` → draft / `action: "confirm"` → confirmed）。プロバイダ非依存で `delivery_log` テーブルに記録 |

---

## 3. shared / parameterized / provider_specific の判定一覧

| # | 要素 | 分類 | 備考 |
|---|---|---|---|
| 1 | `connections` テーブル | `shared` | `provider TEXT` カラムで複数プロバイダ対応済み |
| 2 | `events` テーブル（エンベロープ） | `shared` | `source` カラムでプロバイダ識別。スキーマ変更不要 |
| 3 | Vault ヘルパー (`store_vault_secret` / `read_vault_secret`) | `shared` | シークレット名の命名規則のみ合わせる |
| 4 | `connector_limits` テーブル | `shared` | MS Graph用のレート制限行を `INSERT` するだけ |
| 5 | 冪等性ロジック (`event-id.ts` / SHA256) | `shared` | 入力文字列のプレフィックスを変えるだけ |
| 6 | エンベロープ変換ロジック | `parameterized` | フィールドマッピング（`summary`→`subject` 等）の差し替えで対応 |
| 7 | sensitivity 分類 (`S1` 固定) | `shared` | MS側も同じ `S1` + 機微検出時S2格下げルールを適用 |
| 8 | フロントエンド接続ハブ | `parameterized` | 「Outlookカレンダー」カード追加。`getConnection("outlook_calendar")` で判定 |
| 9 | 接続一覧API (`/api/connections`) | `shared` | `connections` テーブルからの汎用クエリ。変更不要 |
| 10 | ワンタップ下書き (`onetap-calendar`) | `shared` | `delivery_log` に書くだけでプロバイダ非依存 |
| 11 | OAuth開始エンドポイント | `provider_specific` | エンドポイントURL・スコープ形式・PKCE要否がすべて異なる |
| 12 | OAuth コールバック（トークン交換） | `provider_specific` | トークンエンドポイント・パラメータ・レスポンス形式が異なる |
| 13 | カレンダーAPI呼び出し（データ取得） | `provider_specific` | エンドポイント・ページング方式・レスポンスJSON構造がすべて異なる |
| 14 | トークンリフレッシュ | `provider_specific` | Google側は未実装。MS側はリフレッシュトークン90日上限のため必須実装。両プロバイダ共通で新規実装すべき |
| 15 | Delta Query（差分同期） | `provider_specific` | MS Graph 固有の `deltaLink` / `deltaToken` メカニズム。Google Calendar API には同等機能なし |

---

## 4. Microsoft Graph 要件表（Google との対比）

| 項目 | Google Calendar API | Microsoft Graph API | 差異 |
|---|---|---|---|
| **アプリ登録** | Google Cloud Console でプロジェクト作成・OAuth同意画面設定 | Azure AD (Microsoft Entra ID) でアプリ登録。リダイレクトURI・クライアントシークレット設定 | 登録先が異なるだけ。手順は類似 |
| **認証方式** | Authorization Code（サーバーサイド） | Authorization Code + PKCE 推奨。機密クライアントは client_secret でも可 | PKCE対応を検討。既存Google実装はPKCE未使用 |
| **スコープ** | `calendar.readonly` | `Calendars.Read`（委任）が最小。`Calendars.ReadBasic` は件名・時刻のみ（出席者なし） | Sentioは出席者も取得するため `Calendars.Read` が必要 |
| **管理者同意** | 不要（検証済みアプリなら） | **委任 `Calendars.Read` は一般ユーザーが自分で同意可能**。ただしテナント管理者が制限している場合あり | リスク項目として後述 |
| **アクセストークン有効期限** | 1時間 | **1時間**（CAポリシーで短縮可能） | 同等 |
| **リフレッシュトークン有効期限** | 6ヶ月（非使用で失効） | **90日**（非アクティブ14日で失効可能性あり） | MS側が短い。定期的なリフレッシュが必須 |
| **エンドポイント** | `GET /calendars/primary/events` | `GET /me/events` または `GET /me/calendarView` | 構造的には同等 |
| **ページング** | `nextPageToken` パラメータ | `@odata.nextLink` URL（カーソルベース） | 方式が異なる。Google側は現在未実装 |
| **差分取得** | なし（全件再取得） | **Delta Query** (`/me/calendarView/delta`) — `deltaLink` で差分のみ取得 | MS側に優位性あり。初回以降の効率が大幅に改善 |
| **レート制限** | 非公開（実測ベース） | 429 + `Retry-After` ヘッダー。閾値は非公開だがサービス別に存在 | 両者とも非公開。`connector_limits` で管理 |
| **マルチテナント** | N/A（個人Googleアカウント） | シングル/マルチテナント選択必須。SaaSなら**マルチテナント**必須 | アプリ登録時の設計判断が必要 |
| **公開審査** | OAuth検証（2〜6週間） | **なし**（アプリ登録は即時。各テナント管理者が個別に同意） | MS側のほうが早い。ただしテナント管理者同意がゲートになる |

### 出典URL

| 項目 | URL |
|---|---|
| Calendar API概要 | https://learn.microsoft.com/en-us/graph/api/resources/calendar?view=graph-rest-1.0 |
| 認証概念 | https://learn.microsoft.com/en-us/graph/auth/auth-concepts |
| イベント一覧 | https://learn.microsoft.com/en-us/graph/api/user-list-events?view=graph-rest-1.0 |
| Delta Query | https://learn.microsoft.com/en-us/graph/delta-query-events |
| スロットリング | https://learn.microsoft.com/en-us/graph/throttling |
| アプリ登録 | https://learn.microsoft.com/en-us/graph/auth-register-app-v2 |
| 管理者同意 | https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent |
| リフレッシュトークン | https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens |

---

## 5. リスク一覧

| # | リスク | 影響度 | 詳細 |
|---|---|---|---|
| R1 | **管理者同意のハードル** | 高 | 5〜50名規模の中小企業では IT管理者が不在、または社長=管理者だがAzure ADの操作に不慣れな場合が多い。委任スコープ `Calendars.Read` は通常ユーザー同意で通るが、テナント管理者がユーザー同意を無効化している場合は管理者同意が必要になり、オンボーディングが詰まる |
| R2 | **M365プラン差によるAPI利用可否** | 中 | Exchange Online が含まれないプラン（Microsoft 365 Apps for business 等）ではカレンダーAPIが利用不可の可能性がある。Business Basic / Standard / Premium はいずれも Exchange Online を含むが、Apps for business は含まない |
| R3 | **Exchange Online 未契約の構成** | 中 | M365を契約していても Exchange Online がオプションで外されている構成が存在する。この場合 `/me/events` は 404 または空を返す。接続時にExchange Onlineの有無を検出し、適切なエラーメッセージを出す必要がある |
| R4 | **イベント属性の差異によるSense層への影響** | 低 | Google: `summary`, `attendees[].email` → MS: `subject`, `attendees[].emailAddress.address`。フィールド名は異なるが、取得できる情報の粒度はほぼ同等。`metrics` JSONに格納する構造を統一すれば Sense 層への影響はない |
| R5 | **リフレッシュトークン90日失効** | 高 | MS のリフレッシュトークンは最大90日（非アクティブ14日で失効の可能性もある）。Google（6ヶ月）より短いため、定期的なリフレッシュcronが必須。失効時は再認証フローへの誘導が必要 |
| R6 | **トークンリフレッシュ未実装（Google側含む）** | 高 | 現在 Google 側もトークンリフレッシュが未実装。MS コネクタ追加を機に、両プロバイダ共通のリフレッシュ機構を設計すべき |
| R7 | **Delta Query の deltaToken 保存先** | 低 | Delta Query を使う場合、`deltaToken` を `connections` テーブルまたは別テーブルに永続化する必要がある。現行スキーマにはこのカラムがない |

---

## 6. スキーマ変更の要否と提案

### 結論: 小規模な変更が必要。新テーブルは不要

#### 6.1 `connections` テーブル — 変更不要（現状で複数プロバイダ対応済み）

`provider TEXT` + `(company_id, provider)` ユニーク制約により、`provider: "outlook_calendar"` の行を追加するだけで動作する。スキーマ変更は不要。

#### 6.2 `events` テーブル — 変更不要

`source TEXT` カラムに `"outlook_calendar"` を格納する。`event_type: "schedule"`, `sensitivity: "S1"` はGoogle側と同じ。エンベロープ形式は統一済み。

#### 6.3 提案: `connections` テーブルへの `sync_cursor` カラム追加（Delta Query用）

```sql
-- 提案のみ。実行しない。
ALTER TABLE connections ADD COLUMN IF NOT EXISTS sync_cursor TEXT;
-- Delta QueryのdeltaToken、またはGoogle側のsyncTokenを保存
-- NULLなら初回全件同期、値ありなら差分同期
```

この追加は Google 側の `syncToken`（将来実装時）にも利用でき、プロバイダ非依存。

#### 6.4 提案: トークンリフレッシュ用の状態管理

`connections.status` と `connections.expires_at` は既に存在するため、リフレッシュcronジョブが `expires_at` を見て対象を選び、`read_vault_secret` → リフレッシュ → `store_vault_secret` で更新するフローが実装可能。追加カラムは不要。

---

## 7. 梶谷さんが手を動かす必要がある作業の一覧

以下は Azure AD アプリ登録と権限設定に関する手順であり、コード実装の前提条件となる。**調査完了後、速やかに着手すること。**

### 7.1 Azure AD (Microsoft Entra ID) テナントの確認

1. https://entra.microsoft.com/ にアクセスし、Sentio 開発用の Azure AD テナントが存在するか確認する
2. テナントがない場合: https://developer.microsoft.com/en-us/microsoft-365/dev-program から **Microsoft 365 開発者プログラム** に参加し、開発用テナント（E5サンドボックス）を取得する（無料・即時）
3. テナントIDを控える（形式: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`）

### 7.2 アプリ登録

1. Microsoft Entra 管理センター → **アプリの登録** → **新規登録**
2. 設定値:
   - 名前: `Sentio Calendar Connector`（任意）
   - サポートされるアカウントの種類: **「任意の組織ディレクトリ内のアカウント」（マルチテナント）**
   - リダイレクトURI: `http://localhost:3000/auth/callback/outlook`（開発用。本番URLは後で追加）
3. 登録後、以下の値を控える:
   - **アプリケーション (クライアント) ID**
   - **ディレクトリ (テナント) ID**

### 7.3 クライアントシークレットの作成

1. 登録したアプリ → **証明書とシークレット** → **新しいクライアント シークレット**
2. 説明: `Sentio dev`、有効期限: 24ヶ月
3. 生成された **シークレット値** を控える（この画面でしか表示されない）
4. 控えた値は Supabase Vault または `.env.local`（ローカル開発用）に保存。リポジトリには絶対にコミットしない

### 7.4 API アクセス許可の設定

1. 登録したアプリ → **API のアクセス許可** → **アクセス許可の追加**
2. **Microsoft Graph** → **委任されたアクセス許可** → `Calendars.Read` を選択して追加
3. `User.Read`（既定で追加済み）はそのまま残す
4. 「管理者の同意を付与」は **開発テナントでのみ** クリック（本番顧客テナントでは各管理者が個別に同意）

### 7.5 ローカル環境変数の設定

`.env.local` に以下を追加（`.env.example` にキー名のみ追記を依頼する）:

```
MICROSOFT_CLIENT_ID=<7.2で控えたクライアントID>
MICROSOFT_CLIENT_SECRET=<7.3で控えたシークレット値>
MICROSOFT_TENANT_ID=common  # マルチテナントの場合は "common"
```

### 7.6 テスト用カレンダーデータの準備

1. 開発テナントのユーザーで Outlook にログインし、過去3ヶ月分のテストイベント（5〜10件）を手動作成する
2. 出席者付き・終日・繰り返しイベントなど、バリエーションを含める

### 7.7 確認が必要な判断事項

以下はコード実装開始前に判断が必要:

- [ ] ターゲット顧客のM365プランを確認（Business Basic以上か）
- [ ] ターゲット顧客のテナントでユーザー同意が許可されているか（税理士チャネルの顧客数社にヒアリング）
- [ ] 開発者プログラムのE5サンドボックスで十分か、有償テナントが必要か

---

## 8. 次セッションで決めるべき論点

### 8.1 設計判断

| # | 論点 | 選択肢 | 推奨 |
|---|---|---|---|
| D1 | OAuth開始・コールバックの構造 | (a) Google と並列に `/api/auth/outlook/route.ts` を作る (b) 共通OAuthハンドラを作りプロバイダをパラメータ化 | (a) を推奨。現時点でプロバイダは2つだけであり、過剰な抽象化は避ける |
| D2 | トークンリフレッシュ | (a) cron Edge Function で全プロバイダ一括 (b) 各同期時にオンデマンドリフレッシュ | (a) を推奨。同期が失敗してからリフレッシュするのでは遅い |
| D3 | Delta Query の採用 | (a) 初期は全件取得（Google と同じ）、後で差分同期に移行 (b) 最初から Delta Query | (a) を推奨。MVP では全件取得で十分。ただし `sync_cursor` カラムは先に追加しておく |
| D4 | `source` カラムの値 | `"outlook_calendar"` / `"microsoft_calendar"` / `"m365_calendar"` | `"outlook_calendar"` を推奨。ユーザーが認識する名称に合わせる |
| D5 | PKCE の採否 | (a) PKCE なし（client_secret のみ） (b) PKCE あり | (a) で十分。サーバーサイドアプリなので client_secret による機密クライアントフローが適切 |

### 8.2 スライス契約に含めるスコープ

- OAuth フロー（開始・コールバック・トークン保存）
- 初回全件同期（過去12ヶ月・ページング対応）
- エンベロープ変換（`source: "outlook_calendar"`, `event_type: "schedule"`, `sensitivity: "S1"`）
- フロントエンド接続ハブへの「Outlookカレンダー」カード追加
- トークンリフレッシュcron（Google側も含めて共通化するか、MS単独にするか）

### 8.3 スコープ外として明示すべき項目

- Delta Query（差分同期）
- Exchange Online 未契約時の検出とフォールバック
- Google 側のページング対応・トークンリフレッシュ（別スライスで対応）
- カレンダーイベントのタイトル機微検出（S2格下げ）の実装

---

*以上*
