# スライスW — 週次レポート画面（Google 審査シーン4の実体）

- 状態: **active**（2026-08-27 梶谷さん承認・案A）
- 背景: `docs/reports/2026-08-27_デモ動画_シーン4が撮れない.md`
- 上位: `docs/runbooks/2026-08-20_google-oauth-verification.md`【2】シーン4 /【3】審査者向け手順
- 前提: スライスS はクローズ済み（S-3-5 合格 `docs/reports/2026-08-27_S-3-5_本番実測.md`）、
  スライスD は merge 済み（PR #43）

## なぜやるか

Google の差し戻し理由は
「why the following scope(s) are necessary **or why narrower permissions cannot be used**
を十分に示していない」だった。
**スコープを狭めただけでは足りない。「そのスコープで何をしているか」を見せる画面が要る。**

現状、`src/app/` のページは7枚で、**分析結果を出す画面が1枚も無い**。
唯一の出力であるデイリーパルスのメールは
`2026-08-26: 0件のイベントを記録 / 特記事項なし / 状態: 平常` の3行で、
会議時間も出席者数もベースライン比も含まない。

**この画面が無いまま動画を撮ると、前回と同じ理由で落ちる。**
`/privacy` §6 を書いてから slice-D を実装したのと同じ順序で、先にここを埋める。

## 使えるデータ（実測。新しい取得は不要）

`supabase/functions/sync-connections/index.ts:230-241` と
`src/app/auth/callback/google/route.ts:155-` が、すでに次を `events` に入れている。

| カラム | 中身 |
| --- | --- |
| `event_type` | `"schedule"` |
| `source` | `"google_calendar"` |
| `period_start` / `period_end` | 予定の開始・終了（`dateTime` 優先、終日は `date`） |
| `metrics.title` | 予定の件名 |
| `metrics.attendees` | **出席者のメールアドレスの配列** |
| `sensitivity` | `"S1"` |

- 初回連携（Day0）は**過去12ヶ月**を取る（`callback/google/route.ts:130`）
- 定期同期は**過去7日**（`sync-connections/index.ts:20` の `SYNC_DAYS = 7`）

**新しいスコープも新しい API 呼び出しも要らない。既にあるものを画面に出すだけである。**

## 決定

| # | 論点 | 決定 |
| --- | --- | --- |
| **W-D1** | 経路 | `/report`。Server Component。`getAuthedContext()` → RLS クライアント → `src/lib/report/weekly.ts` → クライアント表示。`/connect` と同じ形にする |
| **W-D2** | 集計元 | `events` を直接読む。`baselines` は使わない。**理由**: `state-baselines` の `is_established` が `false` で `observation_count: 0`（2026-08-27 実測）。まだ比較の土台になっていない |
| **W-D3** | 比較 | 当週 vs 前週の**同じ計算をもう一度回すだけ**。前週のデータが無いときは比を出さず「比較できるだけの履歴がありません」と出す（**0%と書かない**） |
| **W-D4** | 出席者 | **メールアドレスを画面に出さない。人数だけを出す。** `metrics.attendees` は S1 の個人データであり、件数以外の用途が無い |
| **W-D5** | 件名 | **出す。** 自社の予定を自社の画面で見るだけであり、Google 審査でも「何を読んでいるか」が伝わる。ただし**他社データが混ざらないこと（RLS）を受入基準で固定する** |
| **W-D6** | 新テーブル | **作らない。** migration 無し。S2 テーブルへの本文型カラム追加も無し（絶対規則） |

## 受入基準

### W-1 系: 集計の正しさ

| # | 基準 | 検証 |
| --- | --- | --- |
| W-1-1 | 週の範囲は **JST の月曜00:00〜日曜23:59:59**。UTC で切らない | unit |
| W-1-2 | 会議件数 = その週に `period_start` が入る `event_type='schedule'` の件数 | unit |
| W-1-3 | 総会議時間 = `period_end - period_start` の合計。**終日予定（`date` 由来で24時間）は別枠で数え、総会議時間に混ぜない** | unit（**陰性コントロール**） |
| W-1-4 | 出席者数は `metrics.attendees` の**要素数**。`null` / 欠損は 0 として扱い、例外にしない | unit |
| W-1-5 | 前週の件数が 0 のとき、増減率を計算せず「比較できるだけの履歴がありません」を返す。**ゼロ除算も「0%」も出さない** | unit（**陰性コントロール**） |

### W-2 系: 見せてはいけないもの

| # | 基準 | 検証 |
| --- | --- | --- |
| W-2-1 | **出席者のメールアドレスが HTML に1文字も出ない** | unit（レンダ結果の文字列検査。**陰性コントロール**） |
| W-2-2 | 他社の `company_id` の予定が1件も混ざらない | integration（2社を作って確認） |
| W-2-3 | 未認証で `/report` を開くと `/login` へ飛ぶ（`/connect` と同じ fail-closed） | integration |
| W-2-4 | `google_calendar` 以外の `source` の行を会議として数えない | unit（陰性コントロール） |

### W-3 系: 空のときの見せ方

| # | 基準 | 検証 |
| --- | --- | --- |
| W-3-1 | 予定が0件の週は「予定がありません」を出す。**失敗と同じ見た目にしない**（運用ルール§6・`LoadState` と同じ原則） | unit |
| W-3-2 | 取得に失敗したときは「読み込めませんでした」を出す。0件と区別する | unit |

## 実装順

1. **`src/lib/report/weekly.ts`（純関数）から書く。** 入力は `events` の配列、出力は集計結果。
   W-1 系と W-2-1 はここで全部テストできる。**陰性コントロール（W-1-3 / W-1-5 / W-2-1 / W-2-4）を先に書く**
2. `src/app/report/page.tsx`（Server Component）＋ 表示コンポーネント
3. `/connect` から `/report` への導線を1本だけ足す

## 非スコープ（**やらない**）

- `baselines` との連携（W-D2）
- freee / CSV 由来の集計。**今回は Google カレンダーだけ**
- グラフ・チャート。数字と前週比の文字表示で足りる
- 期間の切り替え UI。**当週固定**
- デイリーパルスのメール本文の変更（案B は採らなかった）

## 停止点

- **merge はしない。** PR を全緑にした時点で止まって報告する
- 新 migration は入れない。入れたくなったら**止めて相談する**（W-D6 に反する）
- 本番 Ref `kwpldqbnkraftaahnpev` への CLI 直接操作をしない
- `metrics.attendees` の中身をログ・エラー本文・テストフィクスチャに出さない。
  **テストで使うメールアドレスも実在しない値にする**

## この後に続くもの（この契約の外）

1. 動画の撮影（runbook【2】の台本。**シーン4はこの画面で撮る**）
2. runbook【3】の英文を書き直す。
   現行の「You will land on **the dashboard**」「Open the "**Weekly report**" section on the dashboard」は
   **存在しない画面を案内している。** `/report` の実物に合わせること
3. 審査用アカウント（人間作業）→ 再提出

**撮影時の注意**: 本番の `events` は15件で、直近日（`2026-08-26`）は0件。
**予定が入っている週を映すこと。** 空の画面を撮っても意味がない。
