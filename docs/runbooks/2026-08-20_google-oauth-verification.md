# Google OAuth 審査の差し戻し対応（2026-08-20）

対象: プロジェクト `228589171157` / `sentio-492313`
指摘: ①デモ動画 ②テスト用資格情報 ③プライバシーポリシー（3項目）

---

## 【0】最重要 — スコープを狭める。動画を撮り直す前にこれをやる

### 何が問題か

Google の指摘文はこうなっている。

> The demo video you provided does not sufficiently demonstrate **why the following
> scope(s) are necessary or why narrower permissions cannot be used.**
> `https://www.googleapis.com/auth/calendar.readonly`

つまり「narrower が使えない理由を見せろ」である。
**ところが実際には narrower で足りる。** その状態で動画を撮り直しても同じ理由で落ちる。

### 実測（コードが叩いている Google API は1本だけ）

| 場所                                               | 呼び出し                                    |
| -------------------------------------------------- | ------------------------------------------- |
| `src/app/auth/callback/google/route.ts:137`        | `GET /calendar/v3/calendars/primary/events` |
| `supabase/functions/sync-connections/index.ts:199` | `GET /calendar/v3/calendars/primary/events` |

カレンダー一覧（`calendarList`）、カレンダーのプロパティ（`calendars`）、
共有設定（`acls`）、Calendar の設定（`settings`）は**一度も呼んでいない**。

### スコープの比較（公式ドキュメント）

出典: `https://developers.google.com/workspace/calendar/api/auth`

| スコープ                                  | 意味                                                                 | 判定                             |
| ----------------------------------------- | -------------------------------------------------------------------- | -------------------------------- |
| `.../auth/calendar.readonly`              | See and **download any calendar** you can access using your Calendar | **過剰**                         |
| `.../auth/calendar.events.readonly`       | **View events** on all your calendars                                | **これで足りる**                 |
| `.../auth/calendar.events.owned.readonly` | See the events on Google calendars **you own**                       | 狭すぎる。招待された予定が落ちる |

`primary` カレンダーには**自分が招待された予定**も含まれる。会議の負荷を測るには
それが要るので、`events.owned.readonly` では足りない。**`calendar.events.readonly` が最小。**

### やること

1. `src/app/api/auth/google/route.ts:31` の `scope` を
   `https://www.googleapis.com/auth/calendar.events.readonly` に変更
2. `src/app/auth/callback/google/route.ts:101` の `scopes: ["calendar.readonly"]` を
   `["calendar.events.readonly"]` に変更
3. Google Cloud Console の OAuth 同意画面で、要求スコープを
   `calendar.events.readonly` に差し替え、`calendar.readonly` を**削除する**
4. **既存の連携済みユーザーは再同意が必要**になる。本番にユーザーがいないうちに実施する
   （2026-08-20 時点で `baselines` / `delivery_log` / `budget_usage` すべて 0行）
5. 差し替え後に実際に連携し、**同意画面に `calendar.events.readonly` が出ること**、
   および予定の取得が成功することを実測する

**この差し替えが済んでから動画を撮る。** 順序を逆にすると撮り直しになる。

---

## 【1】プライバシーポリシー（対応済み・要デプロイ）

`src/app/privacy/page.tsx` を改訂した。指摘3点に節を対応させてある。

| Google の指摘                                                              | 対応した節                                                                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| does not state with whom you share, transfer, or disclose Google user data | **4. Google ユーザーデータの共有・移転・開示先**（委託先4社の表つき）                                         |
| does not specify any data protection mechanisms for sensitive data         | **5. 安全管理措置**（TLS / 保存時暗号化 / Vault / RLS / 認証必須化 / 最小取得 / 従業者制限）                  |
| does not include any information around the retention or deletion          | **6. Google ユーザーデータの保持期間と削除**（24ヶ月 / 連携解除30日 / アカウント削除30日 / バックアップ35日） |

### ポリシーに書いた内容のうち、実装が伴っていないもの

**書いたことは守らなければならない。** 次の3点は実装が要る（【4】でCCに出す）。

1. **取得から24ヶ月での自動削除** — 現状、保持期間の定義も削除の仕組みも無い
2. **連携解除時に30日以内に当該データを削除** — 現状、解除フック自体が無い
3. **アカウント削除の請求から30日以内** — 当面は `support@` 経由の手作業運用。
   運用手順書が要る（実装は次スライス）

> **注意**: 1 と 2 が動く前に審査へ再提出すると、書いた内容と実態が食い違う。
> 審査者が試すかは別として、**書いた時点で守る義務が発生する**。

---

## 【2】デモ動画の台本

### 撮影条件（Google の要求）

- **publishing status は "In Production" のまま**にすること
- 本番のユーザーに未検証スコープを流さない。本番アプリ内の**ステージング経路**で撮る
- **要求する全スコープの完全な機能**を見せる。今回は `calendar.events.readonly` 1本
- 画面録画。音声かキャプションで各場面を説明する

### 台本（推奨 4〜6分・順序を守る）

**シーン1: アプリの正体を示す（30秒）**

- `https://sentio-ai.jp/` のトップを開く
- ナレーション例:
  > "Sentio is a business intelligence service for small and medium companies in Japan.
  > It reads data the company already has — read-only — and detects changes without
  > requiring anyone to input or report anything."
- URL バーを映し、**アプリ名とドメインが Cloud Console の登録と一致**していることを見せる

**シーン2: 連携の入口（30秒）**

- ログイン → 接続画面へ
- "Connect Google Calendar" のボタンを映す
- ナレーション:
  > "The user connects their Google Calendar here. This is the only place
  > Sentio asks for Google access."

**シーン3: 同意画面（60秒・ここが本番）**

- ボタンを押し、**Google の同意画面を全画面で映して静止する**
- **要求スコープの行を拡大して読み上げる**
  > "The only scope requested is `calendar.events.readonly` —
  > View events on your calendars. Sentio cannot create, edit, or delete events,
  > and cannot see your calendar list, sharing settings, or calendar properties."
- 同意して戻る

**シーン4: 取得したデータが何に使われるか（90秒・最重要）**

Google は「**このスコープを使うユーザー向け機能の最大範囲**」を見たがっている。
取得しただけの画面では足りない。**予定データが実際に成果物に化ける所まで映すこと。**

- 連携直後の初回分析（Day0）が走る様子
- **予定から導かれた出力を具体的に映す**。例:
  - 「会議時間が先月比で N% 増えている」
  - 「特定の取引先との接触が M週間途絶えている」
  - 週次レポートの該当セクション
- ナレーション:
  > "Sentio uses the event's start time, end time, title, and the number of
  > attendees to measure how the company's time is being spent, and compares it
  > against the company's own baseline. This is the entire use of the Calendar data."

**シーン5: なぜこれ以上狭められないか（45秒）**

- ナレーション:
  > "We evaluated narrower scopes.
  > `calendar.events.owned.readonly` covers only events on calendars the user owns,
  > which excludes meetings the user was invited to. Since meeting load is the core
  > signal Sentio measures, those events are required.
  > `calendar.freebusy` returns only busy blocks without titles or attendee counts,
  > which cannot support the analysis.
  > `calendar.events.readonly` is the narrowest scope that works, and it is the only
  > Calendar scope we request."

**シーン6: 取り消しと削除（45秒）**

- 連携解除の操作を映す
- 解除後、画面が「要再連携」になることを映す
- ナレーション:
  > "The user can disconnect at any time. On disconnect, Sentio immediately destroys
  > the tokens and deletes the Calendar data derived from that connection within 30 days,
  > as stated in our privacy policy."

### 撮ってはいけないもの

- **本番の他社データ**。撮影用の会社アカウントを使うこと
- **アクセストークン・API キーが映る画面**（DevTools、環境変数、ログ）
- 未検証スコープを本番の実ユーザーに向けて流すこと

---

## 【3】テスト用資格情報と手順書（審査者へ提出する英文）

### 用意するもの（人間作業）

1. 審査用の**専用アカウント**を1つ作る。パスワード認証のみで入れること
2. **電話番号確認・クレジットカード登録・招待コードなど、認証の障害物を全部外す**
   （Google が明示的に要求している）
3. そのアカウントに**予定が入っている Google アカウント**を1つ連携しておく。
   予定が空だと分析結果が出ず、シーン4に相当する画面を審査者が再現できない
4. 下の英文の `<...>` を埋めて Cloud Console の
   "Provide test credentials / instructions" 欄に貼る

### 提出する英文

```text
TEST CREDENTIALS

  URL:      https://sentio-ai.jp/login
  Email:    <review-account@example.com>
  Password: <password>

  No phone verification, no credit card, and no invitation code are required
  for this account. It signs in with email and password only.

STEP-BY-STEP NAVIGATION

  1. Open https://sentio-ai.jp/login
  2. Enter the email and password above, then click "Log in".
  3. You will land on the dashboard. If a Google Calendar connection already
     exists, its status is shown as "Connected".
  4. To see the OAuth flow yourself, click "Connect" next to Google Calendar.
     The Google consent screen will show a single scope:
       https://www.googleapis.com/auth/calendar.events.readonly
     Approve it with your own Google account.
  5. After the redirect back to Sentio, the initial analysis runs automatically.
     It reads events from the primary calendar for the past 12 months.
  6. Open the "Weekly report" section on the dashboard. The section titled
     <SECTION NAME> is generated entirely from Calendar events: it compares the
     number of meetings, total meeting hours, and attendee counts against the
     company's own baseline.
  7. To verify the read-only behaviour, open Google Calendar in another tab.
     No event has been created, modified, or deleted by Sentio.
  8. To disconnect, return to the dashboard and click "Disconnect" next to
     Google Calendar. The status changes to "Reconnection required".

WHAT SENTIO DOES WITH CALENDAR DATA

  Sentio calls exactly one Calendar API endpoint:
    GET https://www.googleapis.com/calendar/v3/calendars/primary/events

  From each event it uses: start time, end time, title, and attendee list.
  It uses these to measure how the company's working time is distributed and to
  detect changes against the company's own historical baseline. It does not read
  the calendar list, calendar properties, sharing permissions, or Calendar
  settings, and it never writes to Calendar.
```

---

## 【4】審査への返答文（英文）

Cloud Console の再提出フォーム、または審査担当への返信に貼る。

```text
Thank you for the review. We have addressed all three items.

1. SCOPE REDUCTION (in response to the demo video feedback)

Rather than justifying the broader scope, we narrowed it.

Sentio calls exactly one Google Calendar endpoint:
  GET /calendar/v3/calendars/primary/events

We have therefore replaced
  https://www.googleapis.com/auth/calendar.readonly
with
  https://www.googleapis.com/auth/calendar.events.readonly

This is the narrowest Calendar scope that supports our feature. We considered
and rejected the following narrower alternatives:

  - calendar.events.owned.readonly
      Returns only events on calendars the user owns. It excludes meetings the
      user was invited to. Meeting load, including invited meetings, is the core
      signal our product measures, so these events are required.

  - calendar.freebusy
      Returns busy/free blocks only, without event titles or attendee counts.
      Our analysis compares meeting composition over time and cannot be built
      from busy blocks alone.

We do not read calendarList, calendars, acls, or settings, and we never write
to Calendar.

2. DEMO VIDEO

A new recording is attached. It shows, in order: the product, the connection
entry point, the full consent screen with the single requested scope, the
user-facing output generated from Calendar events, our evaluation of narrower
scopes, and the disconnection flow. The app's publishing status remained
"In Production" and the recording uses a dedicated demo account, not production
customer data.

3. TEST CREDENTIALS

Active credentials and step-by-step navigation instructions are provided in the
"test credentials" field. The account requires no phone verification, no credit
card, and no invitation code.

4. PRIVACY POLICY

  https://sentio-ai.jp/privacy   (Japanese; our users are Japanese SMEs)

  - Section 4 "Sharing, transfer and disclosure of Google user data"
      Names every sub-processor (Supabase, Anthropic, Resend, Vercel), states
      exactly what each one does with Google user data, and their location.
      States explicitly that we do not sell Google user data, do not use it for
      advertising, and do not provide it to other customers.

  - Section 5 "Security measures"
      TLS in transit, encryption at rest, OAuth tokens isolated in Supabase Vault
      and never written to tables, logs, source code or configuration files,
      Row Level Security on every table, authentication required on every
      server-side endpoint, read-only Calendar access, and restricted employee
      access to production data.

  - Section 6 "Retention and deletion of Google user data"
      Google user data is deleted 24 months after collection. On disconnection,
      tokens are destroyed immediately and the derived Calendar data is deleted
      within 30 days. On an account deletion request, all data is deleted within
      30 days. Backups roll over within 35 days.

Please let us know if anything else is required.
```

---

## 【5】実装が要るもの（CC へ）

ポリシーに書いた以上、次は実装しないと記述と実態が食い違う。

| #   | 内容                                                          | 期限               |
| --- | ------------------------------------------------------------- | ------------------ |
| 1   | スコープを `calendar.events.readonly` に差し替え（2ファイル） | **再提出前**       |
| 2   | 連携解除時に、当該コネクタ由来の `events` を削除する経路      | **再提出前**       |
| 3   | 取得から24ヶ月経過した `events` を削除する定期処理            | 再提出前が望ましい |
| 4   | アカウント削除の**運用手順書**（実装は次スライス）            | 再提出前           |
| 5   | `07_open_items.md` に「アカウント削除APIの実装」を登録        | 随時               |

**2 と 3 は削除処理なので、CLAUDE.md の「Sentio は何も勝手に送らない・登録しない」とは
別方向の危険がある。** 消しすぎる事故を防ぐため、次を必須とする。

- 削除対象の抽出条件をテストで固定する（陽性・陰性コントロール）
- 削除前に件数を数え、想定を超えたら**止める**（fail-closed）
- 本番反映は CI/CD 経由のみ

---

## 【6】順序（これを守る）

```
1. スコープ差し替え（コード2ファイル）           ← CC
2. 連携解除時の削除・24ヶ月削除の実装            ← CC
3. PR → CI 緑 → merge → deploy                  ← CC / 梶谷さん
4. 本番の /privacy が改訂版になっていることを確認 ← 検収者
5. Cloud Console の同意画面のスコープを差し替え   ← 梶谷さん
6. 差し替え後に実際に連携して同意画面を実測       ← 梶谷さん
7. デモ動画を撮る（【2】の台本）                  ← 梶谷さん
8. テストアカウントを作る（【3】）                ← 梶谷さん
9. 再提出（【4】の返答文）                        ← 梶谷さん
```

**4 より前に 9 をやらない。** Google はポリシーの URL を実際に取りに来る。
