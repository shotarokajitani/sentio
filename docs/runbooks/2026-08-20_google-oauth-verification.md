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

**書いたことは守らなければならない。** 当初挙げた3点の現況（2026-08-29 時点）。

1. ~~**取得から24ヶ月での自動削除**~~ — **一部完了。まだ回っていない。**
   保持期間の定義・削除関数・消しすぎを止める門は実装済み
   （PR #35 / `supabase/functions/retention-purge/` / `src/lib/retention/policy.ts`、
   陽性・陰性コントロールは `tests/unit/retention-policy.test.ts`）。
   deploy もされている（`.github/workflows/deploy.yml` の Deploy retention-purge）。
   **ただし cron 登録が無い。** `supabase/migrations/` で `cron.schedule` を張っているのは
   `sync-connections` だけで（00018 / 00020）、`retention-purge` は手動起動でしか動かない。
   契約側もそう書いてある（`docs/contracts/slice-disconnect.md` の非スコープ:
   「`retention-purge` の cron 登録 — **A-2 の範囲**」）。**定期処理としては未達。**
2. ~~**連携解除時に30日以内に当該データを削除**~~ — **完了（2026-08-27、PR #43／スライスD）。**
   画面からの解除は、トークンの破棄と当該コネクタ由来 `events` の削除を
   **同一リクエストで即時**に行う（`src/app/api/connections/disconnect/route.ts`）。
   「30日以内」は0日でも満たす（契約 D-1）。
   `invalid_grant` 経由の経路だけは `revoked_at` から30日待つ形なので、
   **こちらは 1 の cron が回るまで完了しない**（契約 D-3 / D-5）
3. ~~**アカウント削除の請求から30日以内**~~ — **運用手順書は完了。**
   `docs/runbooks/2026-08-20_account-deletion.md` にある（`support@` 経由の手作業運用）。
   API 実装は未着手のままで、`docs/spec/07_open_items.md`
   「アカウント削除APIの実装（2026-08-20 登録・**公開済みの約束あり**・未着手）」に登録済み

> **残っているのは 1 の cron 登録だけである。** これが回るまで、
> 「24ヶ月で自動削除」と `invalid_grant` 経由の30日削除は**書いてあるだけ**の状態が続く。
> 再提出は済んでいる（【4】実施記録）ので、審査に間に合わせる話ではなく、
> **公開済みの約束を履行する話**として A-2 で片付ける。

---

## 【2】デモ動画の台本

### 撮影条件（Google の要求）

- **publishing status は "In Production" のまま**にすること
- 本番のユーザーに未検証スコープを流さない。本番アプリ内の**ステージング経路**で撮る
- **要求する全スコープの完全な機能**を見せる。今回は `calendar.events.readonly` 1本
- 画面録画。音声かキャプションで各場面を説明する

### 収録のしかた（2026-08-28 追記・実測済み）

**画面録画の開始・停止だけは人間の手で行う。それ以外はエージェントが行う。**

#### なぜエージェントだけで完結しないか（4つとも実測した。推測ではない）

| #   | 試したこと                                                  | 結果                                                                                                                            |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | computer-use で Chrome を操作して録画を開始する             | **不可**。ブラウザは設計上 tier `read` 固定で、クリック・キー入力が拒否される（実際に `left_click` が拒否された）。回避しない   |
| 2   | Chrome MCP で対象ウィンドウを最前面に持ってくる             | **不可**。タブは操作できるがウィンドウの前面化・新規ウィンドウ作成の API が無い。Game Bar は最前面ウィンドウを録る              |
| 3   | サンドボックスで headless Chromium を動かしてフレームを作る | **不可**。`playwright install chromium` がネットワーク制限で失敗（`Download failure`）。sudo も不可                             |
| 4   | `gif_creator` で録って mp4 に起こす                         | **不可**。出力は人間の Downloads にしか落ちず、サンドボックスからは読めない（`/mnt/sentio` `/mnt/outputs` `/mnt/uploads` のみ） |

**したがって分担はこうなる。**

| 誰が             | 何を                                                                  |
| ---------------- | --------------------------------------------------------------------- |
| 梶谷さん         | ① Sentio のタブを最前面にする ② 録画開始（Win+Alt+R）③ 終わったら停止 |
| 検収者（Cowork） | **残り全部。**画面遷移・クリック・英語字幕の表示                      |

出力は `C:\Users\shota\Videos\Captures\*.mp4`。そのまま Google に上げられる。

#### 英語字幕はページに焼き込む（実装済み・2026-08-28 実測）

ナレーションを後付けせず、**本番のページに字幕バーを差し込んで録る。**
`javascript_tool` で次を流すと、画面下部に固定の字幕帯が出る（実測: 高さ72px・可読）。

```js
(function () {
  var id = "sentio-demo-caption";
  var el = document.getElementById(id);
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    document.body.appendChild(el);
  }
  el.setAttribute(
    "style",
    "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;" +
      "background:rgba(12,18,32,0.92);color:#fff;font-family:-apple-system,Segoe UI,Roboto,sans-serif;" +
      "font-size:21px;line-height:1.5;padding:20px 40px;text-align:center;letter-spacing:.2px;" +
      "box-shadow:0 -2px 20px rgba(0,0,0,.35)",
  );
  el.textContent = "<CAPTION TEXT>";
})();
```

**字幕は本番のページの上に出るだけで、DBにもコードにも何も足していない。**
リロードすれば消える。

#### 各シーンの字幕（英語・そのまま使う）

| シーン | 画面            | 字幕                                                                                                                                                                                                                                                               |
| ------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1      | `/`             | `Sentio — a business intelligence service for small and medium companies in Japan. It reads data the company already has, read-only.`                                                                                                                              |
| 2      | `/connect`      | `This screen is the only place Sentio asks for Google access. The interface is Japanese; our users are Japanese SMEs.`                                                                                                                                             |
| 3      | Google 同意画面 | `The only scope requested is calendar.events.readonly — "View events on your calendars". Sentio cannot create, edit or delete events, and cannot read your calendar list, sharing settings or calendar properties.`                                                |
| 4      | `/report`       | `The only user-facing feature built on Calendar data. From each event Sentio reads the start time, end time, title, and HOW MANY attendees. Attendee email addresses are never displayed or stored — only the count.`                                              |
| 5      | `/report`       | `We evaluated narrower scopes. calendar.events.owned.readonly excludes meetings the user was invited to, which is the core signal we measure. calendar.freebusy has no titles and no attendee counts. calendar.events.readonly is the narrowest scope that works.` |
| 6      | `/connect`      | `The user can disconnect at any time. Sentio asks them to type their own email address first. On disconnect the tokens are destroyed immediately and the imported Calendar events are deleted.`                                                                    |

**録る前に必ず確認すること:**

1. `/report` が空でない（当週に予定があり、`sync-connections` を回した後）
2. ブラウザのタブに**他社データ・DevTools・環境変数・トークン**が映っていない
3. 通知（Slack / メール）を止める
4. **シーン6は最後**。解除すると連携が切れる

### 台本（推奨 4〜6分・順序を守る）

**シーン1: アプリの正体を示す（30秒）**

- `https://sentio-ai.jp/` のトップを開く
- ナレーション例:
  > "Sentio is a business intelligence service for small and medium companies in Japan.
  > It reads data the company already has — read-only — and detects changes without
  > requiring anyone to input or report anything."
- URL バーを映し、**アプリ名とドメインが Cloud Console の登録と一致**していることを見せる

**シーン2: 連携の入口（30秒）**

- `https://sentio-ai.jp/login` でログイン → `/connect`（「会社情報の接続」）へ
- **Google カレンダーの行を映す。** ボタンのラベルは日本語で「**接続**」
  （連携済みなら「**連携を解除**」＋「**接続済み**」）。
  英語の "Connect Google Calendar" というボタンは存在しない
- ナレーション:
  > "The user connects their Google Calendar here. This screen — /connect — is the
  > only place in the product where Sentio asks for Google access.
  > The interface is in Japanese; our users are Japanese small and medium companies."

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

> **2026-08-28 改訂。** この節は当初「ダッシュボードの週次レポート」を前提に書かれていたが、
> **その画面は存在しなかった**（`docs/reports/2026-08-27_デモ動画_シーン4が撮れない.md`）。
> スライスW で `/report` を作って埋めた（`docs/contracts/slice-weekly-report.md`）。
> **映すのは `https://sentio-ai.jp/report`「今週の会社」である。**

映す手順:

1. `/connect` の「**今週の会社を見る**」を押して `/report` へ入る（導線を見せる）
2. 画面を静止して読み上げる。実際の表示は次の形:

```
今週の会社
接続した Google カレンダーの予定から、今週の会議の量を集計しています。
8月24日 〜 8月30日
会議        5件
総会議時間  5時間
のべ出席者  3人
今週の予定
  週次経営会議                8月24日 10:00–11:00
  新規パートナー商談（初回）  8月25日 14:00–15:30
  開発デイリー                8月26日 09:30–10:00
  顧客定例 — 導入レビュー     8月27日 13:00–14:00
  採用面談（1次）             8月28日 16:00–17:00   出席者 3人
```

3. ナレーション（**実装に合わせて書き換えた。以前の文はまだ無い機能を説明していた**）:

> "This is the only user-facing feature built on Calendar data.
> From each event Sentio reads four things: the start time, the end time, the title,
> and **how many** attendees there are. It counts the meetings in the current week,
> adds up the total meeting hours, and totals the attendees.
> When a previous week is available it also shows the change against that week.
> **Sentio never displays or stores attendee email addresses — only the count.**
> That is the entire use of the Calendar data."

**言ってはいけないこと（実装が無い）**: 「ベースラインと比較している」。
`/report` の比較は**前週との単純比較**であり、`baselines` は使っていない
（契約 W-D2。`is_established: false` / `observation_count: 0`）。

**撮影前の必須確認**: `/report` が空でないこと。
`sync-connections` は過去7日しか取らないので、**当週に予定が入っていないと 0件**になる。
連携中のアカウント（`shotaro.kajitani@mdc-diseno.com`）のカレンダーに当週の予定を入れ、
`invoke-function` で `sync-connections` を1回回してから撮る。

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

> **2026-08-28 改訂。** 当初は「解除後、画面が**要再連携**になる」と書いていたが、
> **実装はそうなっていない。** `POST /api/connections/disconnect` は
> `connections` の行を**その場で削除**し、当該 provider 由来の `events` も消す
> （契約 `slice-disconnect.md` D-1-3）。解除後の画面は「要再連携」ではなく
> **未接続（「接続」ボタンが出る状態）**になる。この誤記のまま撮ると虚偽になる。

- `/connect` の Google カレンダー行にある「**連携を解除**」を押す
- **二段確認が開くところを映す。** 本番の実物（2026-08-27 実測）:

```
Google カレンダーの連携を解除します
この連携から取り込んだデータはすべて削除され、アクセストークン・
リフレッシュトークンは直ちに破棄されます。取り消せません。
続けるには、ログイン中のメールアドレスを入力してください。
［入力欄］  ［連携を解除する］［やめる］
```

- メールアドレスを入力して「連携を解除する」を押す
- **解除後、Google カレンダーの行が未接続（「接続」ボタン）に戻ることを映す**
- ナレーション:
  > "The user can disconnect at any time, from this screen.
  > Sentio asks the user to type their own email address before it proceeds —
  > this cannot be undone. On disconnect, Sentio **immediately** destroys the access
  > and refresh tokens and deletes the Calendar events imported through that
  > connection. Nothing is left behind."

**撮影上の注意**: 解除を実行すると本番の連携が切れる。
撮り直しには Google 同意画面をもう一度通す必要がある（＝シーン3をもう一度撮れる）。
**シーン6を最後に撮り、その後に再連携する**のが手戻りが少ない。

### 撮ってはいけないもの

- **本番の他社データ**。撮影用の会社アカウントを使うこと
- **アクセストークン・API キーが映る画面**（DevTools、環境変数、ログ）
- 未検証スコープを本番の実ユーザーに向けて流すこと

---

## 【3】テスト用資格情報と手順書（審査者へ提出する英文）

### 実施状況（2026-08-29）

**✅ 審査用アカウントは作成・連携済み。**

| 項目                  | 状態                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| アカウント            | `shotaro.kajitani+google-review@mdc-diseno.com`（梶谷さんが作成。**エージェントはアカウント作成・パスワード入力を行わない**） |
| Google カレンダー連携 | **済み。** 同意画面で「すべてのカレンダーの予定を表示」1件のみを許可 → **過去12ヶ月から20件取り込み**                         |
| `/report`             | **実データで表示。** 会議 5件 / 総会議時間 5時間 / のべ出席者 3人 ＋ 予定5件の一覧                                            |
| 認証の障害物          | 電話番号確認・クレジットカード・招待コード **いずれも無し**（メール＋パスワードのみ）                                         |

**パスワードはこのリポジトリのどこにも書かない**（`CLAUDE.md` の絶対規則）。
Cloud Console の "Provide test credentials" 欄に梶谷さんが直接貼ること。

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
  Email:    shotaro.kajitani+google-review@mdc-diseno.com
  Password: <PASTE HERE — never written into the repository>

  No phone verification, no credit card, and no invitation code are required
  for this account. It signs in with email and password only.

  A Google Calendar is already connected to this account, so the weekly report
  at https://sentio-ai.jp/report is populated when you sign in. You do not have
  to run the OAuth flow yourself unless you want to see it.

STEP-BY-STEP NAVIGATION

  1. Open https://sentio-ai.jp/login
  2. Enter the email and password above, then click "ログイン" (Log in).
  3. You will land on the connection screen (/connect). Each data source is
     listed there. If a Google Calendar connection already exists, it is shown
     as "接続済み" (Connected).
  4. To see the OAuth flow yourself, click "接続" (Connect) next to
     "Google カレンダー". The Google consent screen will show a single scope:
       https://www.googleapis.com/auth/calendar.events.readonly
     Approve it with your own Google account.
  5. After the redirect back to Sentio, the initial import runs automatically.
     It reads events from the primary calendar for the past 12 months.
  6. Click "今週の会社を見る" (View this week) on the connection screen, or open
     https://sentio-ai.jp/report directly. This page is generated entirely from
     Calendar events. It shows, for the current week (Monday to Sunday, JST):
       - 会議        the number of meetings
       - 総会議時間  the total meeting hours
       - のべ出席者  the total attendee COUNT
       - 今週の予定  each meeting's title, date and start/end time
     When a previous week is available, it also shows the change against it.
     Attendee email addresses are never displayed or stored in this page —
     only how many attendees each meeting had.
  7. To verify the read-only behaviour, open Google Calendar in another tab.
     No event has been created, modified, or deleted by Sentio.
  8. To disconnect, return to /connect and click "連携を解除" (Disconnect) next to
     Google Calendar. A confirmation panel appears and asks you to type the
     signed-in email address before it will proceed. After confirming, the
     tokens are destroyed immediately, the imported Calendar events are deleted,
     and the row returns to the not-connected state ("接続" button).

  NOTE ON LANGUAGE
  The interface is in Japanese because our users are Japanese SMEs. The Japanese
  labels above are quoted exactly as they appear on screen.

WHAT SENTIO DOES WITH CALENDAR DATA

  Sentio calls exactly one Calendar API endpoint:
    GET https://www.googleapis.com/calendar/v3/calendars/primary/events

  From each event it uses four things: the start time, the end time, the title,
  and the NUMBER of attendees. Attendee email addresses are never displayed and
  are never stored outside the raw event record; the product only ever uses the
  count. It uses these to measure how the company's working time is distributed
  and to show the change against the previous week. It does not read the calendar
  list, calendar properties, sharing permissions, or Calendar settings, and it
  never writes to Calendar.
```

---

## 【4】審査への返答文（英文）

> **2026-08-29 訂正。Cloud Console に再提出フォームは無い。**
> 検証センターは進捗表示だけで、入力欄は存在しない（実測）。
> Google 側も
> 「**reply directly to this email** with clarification and/or your new
> demonstration video to continue the review」と明示している。
> **提出は審査担当へのメール返信で行う。**
>
> | 項目     | 値                                                            |
> | -------- | ------------------------------------------------------------- |
> | スレッド | `[Action Needed] OAuth Verification Request Acknowledgement`  |
> | 返信先   | `api-oauth-dev-verification-reply+3n9o3otkyudyp1d@google.com` |
> | 返信対象 | 2026-08-24 のスコープ不一致の指摘メール                       |
>
> **動画は「公開アクセス可能な URL」で渡す。** 添付ではない。
> 2026-08-19 に一度「video link にアクセスできない」で差し戻されているので、
> **サインアウト状態で開けることを確認してから**貼ること（前回は YouTube の限定公開を使用）。
>
> 検証センターの現況（2026-08-29 実測）:
> ブランドの取り扱いガイドライン ✅（最終審査日 2026/08/24）/
> ホームページの要件・プライバシーポリシーの要件・アプリの機能・
> 適切なデータアクセス・最小スコープのリクエスト は審査中。

以下は返信本文。

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

  <PASTE THE PUBLIC VIDEO URL HERE>

The recording is provided as a publicly accessible link, not as an attachment.
It shows, in order: the product, the connection
entry point (/connect), the full Google consent screen with the single requested
scope held on screen, the import result, the user-facing output at
https://sentio-ai.jp/report which is generated entirely from Calendar events,
our evaluation of narrower scopes, and the disconnection flow carried out to
completion. The app's publishing status remained "In Production" and the
recording uses a dedicated demo account, not production customer data.

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
      Google user data is deleted 24 months after collection. The policy commits
      to deleting the derived Calendar data within 30 days of disconnection; in
      the current implementation both the tokens and the imported Calendar events
      are destroyed immediately, in the same request. On an account deletion
      request, all data is deleted within 30 days. Backups roll over within
      35 days.

Please let us know if anything else is required.
```

## 実施記録（2026-08-29）

**返信を送信済み。** スレッド `[Action Needed] OAuth Verification Request Acknowledgement` の
2026-08-24「スコープ不一致」のメールに対する返信として送った。

| 項目           | 内容                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| 宛先           | `api-oauth-dev-verification-reply+3n9o3otkyudyp1d@google.com`                                                     |
| 動画           | **公開アクセス可能な YouTube の限定公開 URL**（本文に記載。ここには書かない）                                     |
| テスト資格情報 | `shotaro.kajitani+google-review@mdc-diseno.com`（パスワードはここには書かない）                                   |
| 構成           | 1. スコープ不一致の解消 / 2. 最小スコープの根拠 / 3. 動画 / 4. テスト資格情報＋手順1〜8 / 5. プライバシーポリシー |

**送信後に見つかった不具合**: Gmail が本文中の URL を `google.com/url?q=...` に
書き換えた。1行だけ壊れている。

> The authorization URI our app generates ... it contains scope=https%3A%2F% ...

パーセントエンコードした文字列が途中で切れてリンクに化けた。**内容の誤りではない**
（同じ主張は第1節で正しく書けている）。次回以降、**本文にパーセントエンコードした
URL を書かない**こと。

---

## 【5】実装が要るもの（CC へ）

ポリシーに書いた以上、次は実装しないと記述と実態が食い違う。

**2026-08-29 時点の消し込み。** 5件中4件が完了。残りは 3 の cron 登録のみ。

| #   | 内容                                                          | 状態                              | 実施日・参照                                                                                              |
| --- | ------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | スコープを `calendar.events.readonly` に差し替え（2ファイル） | ~~完了~~                          | 2026-08-21 / PR #35（`src/app/api/auth/google/route.ts:37`・`src/app/auth/callback/google/route.ts:102`） |
| 2   | 連携解除時に、当該コネクタ由来の `events` を削除する経路      | ~~完了~~                          | 2026-08-27 / PR #43・`docs/contracts/slice-disconnect.md`（画面からの解除は即時削除）                     |
| 3   | 取得から24ヶ月経過した `events` を削除する定期処理            | **未完了（関数のみ・cron 無し）** | 関数は PR #35 で実装・deploy 済み。`cron.schedule` 未登録のため回っていない。**A-2 へ**                   |
| 4   | アカウント削除の**運用手順書**（実装は次スライス）            | ~~完了~~                          | 2026-08-20 / `docs/runbooks/2026-08-20_account-deletion.md`                                               |
| 5   | `07_open_items.md` に「アカウント削除APIの実装」を登録        | ~~完了~~                          | 2026-08-20 / `docs/spec/07_open_items.md`（未着手として登録済み）                                         |

**2 と 3 は削除処理なので、CLAUDE.md の「Sentio は何も勝手に送らない・登録しない」とは
別方向の危険がある。** 消しすぎる事故を防ぐため、次を必須とする。

- 削除対象の抽出条件をテストで固定する（陽性・陰性コントロール）
- 削除前に件数を数え、想定を超えたら**止める**（fail-closed）
- 本番反映は CI/CD 経由のみ

---

## 【6】順序（これを守る）

**9件すべて実施済み（2026-08-29）。** 残りは 2 の 24ヶ月削除の cron 登録だけ。

```
1. スコープ差し替え（コード2ファイル）           ← CC       [済]   2026-08-21 PR #35
2. 連携解除時の削除・24ヶ月削除の実装            ← CC       [一部] 解除=済 PR #43 / 24ヶ月=関数のみ・cron 未登録
3. PR → CI 緑 → merge → deploy                  ← CC/梶谷さん [済] PR #35 / #43 / #45
4. 本番の /privacy が改訂版になっていることを確認 ← 検収者   [済]   2026-08-29 実測（下記）
5. Cloud Console の同意画面のスコープを差し替え   ← 梶谷さん [済]   2026-08-24 までに完了
6. 差し替え後に実際に連携して同意画面を実測       ← 梶谷さん [済]   デモ動画の収録で実測
7. デモ動画を撮る（【2】の台本）                  ← 梶谷さん [済]   2026-08-28 収録・公開URLで提出
8. テストアカウントを作る（【3】）                ← 梶谷さん [済]   【3】の資格情報で提出済み
9. 再提出（【4】の返答文）                        ← 梶谷さん [済]   2026-08-29 メール返信（【4】実施記録）
```

**4 より前に 9 をやらない。** Google はポリシーの URL を実際に取りに来る。

4 の実測（2026-08-29）。`sentio-ai.jp` は `www` へ 307 で飛ぶので `-L` が要る:

```
$ curl -sSL -o /tmp/privacy.html -w "final HTTP %{http_code} url=%{url_effective}
" https://sentio-ai.jp/privacy
final HTTP 200 url=https://www.sentio-ai.jp/privacy

$ grep -o "<h2[^>]*>[^<]*</h2>" /tmp/privacy.html
<h2>4. Google ユーザーデータの共有・移転・開示先</h2>
<h2>5. 安全管理措置</h2>
<h2>6. Google ユーザーデータの保持期間と削除</h2>
```

**2 の 24ヶ月削除だけが残っている**（cron 未登録）。【1】に理由と参照を書いた。

---

# 承認（2026-09-02）

**4回目の提出で承認された。**

```
We've approved your OAuth App Verification request
for project 228589171157 (Project ID: sentio-492313)
  .../auth/calendar.events.readonly
```

承認されたスコープは **`calendar.events.readonly` の1本**で、
コード側（`src/app/api/auth/google/route.ts:37`）と一致している。

## 4回の差し戻しと、それぞれ何を直したか

| #   | 差し戻しの理由                                              | 対応                                                                                                     |
| --- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | 動画URLのタイポで開けなかった                               | URL を訂正                                                                                               |
| 2   | スコープ過大 ＋ テスト資格情報 ＋ プライバシーポリシーの3点 | `calendar.readonly` → **`calendar.events.readonly`** に絞る。他2点も対応                                 |
| 3   | コードと Console のスコープが不一致                         | **コード側を狭い方に合わせた**                                                                           |
| 4   | 同意画面でスコープが展開されていない                        | (i) を押した状態で撮り直し、**かつ「スコープが1本なので Show all services は存在しない」と明記して返信** |

## 決め手は4回目の「**なぜ見つからないか**」の説明

差し戻し文には毎回「**Show all services をクリックして展開せよ**」と書かれていた。
しかし **Sentio の同意画面にそのボタンは存在しない。** スコープが1本しか無いためである。

**動画を撮り直して出すだけでは、審査者は探して見つからず、同じ指摘が返ってくる。**
4回目で足したのは映像ではなく、**「そのボタンが無い理由」の説明**である。

要求どおりの画面を作れないとき、**作れない理由を説明する**という手が要る。
「言われたとおりに直しました」だけでは通らない差し戻しがある。

## 3回目の判断: **Console ではなくコードを動かした**

不一致を直す方向は2つあった。

| 方向                                                     | 結果                                                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Console を**広い方**（`calendar.readonly`）に合わせる    | **より重い審査になる。** 読み取り範囲が広がり、正当化する説明が増える                              |
| **コードを狭い方**（`calendar.events.readonly`）に寄せる | **採用。** 実測でコードが叩く Google API は `calendars/primary/events` の1本だけで、狭い方で足りる |

**逆にしていたら、4回目では終わっていなかった可能性が高い。**
「不一致を直す」は方向が2つあり、**狭い方に寄せるのが常に安い。**

## これ以降の注意

承認メールにこの一文がある。

> You will need to submit a new verification request for access to new scopes,
> or if you make any changes to your OAuth consent screen configuration.

**同意画面の設定を変えると、再審査に戻る。** 引き金の一覧と守れない範囲は
`.claude/rules/oauth-consent-screen.md` に置いた。
