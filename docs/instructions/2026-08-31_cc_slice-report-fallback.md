# Claude Code への指示文（スライスRF）— 2026-08-31

**この本文をそのまま Claude Code に貼る。** PowerShell には貼らない。

---

契約 `docs/contracts/slice-report-fallback.md`（スライスRF）を実装してください。
起草は 2026-08-31、梶谷さん承認済み・active です。**契約を先に全文読んでから着手してください。**

## 背景（1行）

`/report` は当週固定、`sync-connections` は `timeMax = now`。
**未来の予定は同期されないので、月曜の朝は構造的に必ず0件になる。**
実測記録は `docs/reports/2026-08-31_report が月曜に必ず空になる.md`。

## やること

当週が0件のとき、**直近の「会議がある週」へ最大8週まで遡って表示する。**
遡ったことは画面に一文で明示する。

### 触るファイル

```
shared/report/weekly.ts          resolveWeekReference / FALLBACK_MAX_WEEKS / isFallback
src/lib/report/events.ts         取得窓を広げ、基準週を決めてから summarizeWeek に渡す
src/app/report/report-view.tsx   isFallback のとき一文出す
src/i18n/ja.ts                   report.fallbackNotice を追加
tests/unit/…                     RF-1 / RF-2 / RF-3 系
```

### 設計上の要点（**ここを外さないこと**）

1. **`summarizeWeek` のシグネチャを変えない。** 呼び出し側が渡す `reference` を変えるだけ。
   これで `deliver-weekly`（`supabase/functions/_shared/weekly-sections.ts` 経由で
   同じ純関数を読んでいる）に影響が出ない
2. **週の選択は純関数に置く。** DB のクエリで週を決めない。
   `src/lib/report/events.ts` は窓を広げて渡すだけ
3. **前週比は「表示している週の前週」と比べる**（RF-D5）。
   したがって取得窓は当週の**9週前**の週頭から必要（遡り8週＋その前週）
4. **未来の週を選ばない**（RF-D4）。遡る方向にしか動かない
5. `Intl.DateTimeFormat` は**モジュールスコープで `timeZone: "Asia/Tokyo"` を明示**する
   既存の形を崩さない（React #418 の再発防止・RF-3-4）

### 陰性コントロールを必ず書く（**これが本体です**）

契約の受入基準のうち、次の4つは**「やってはいけないこと」の検査**です。
陽性だけ書いて出さないでください。

- **RF-1-1**: 当週に会議があるとき、**遡らない**（黙って週をずらさない）
- **RF-1-5**: 8週遡っても0件なら、**遡らず当週の空状態**（`isFallback === false`）
- **RF-1-6**: 未来にしか予定が無くても、**未来の週を選ばない**
- **RF-3-1**: 出席者のメールアドレスが画面に1文字も出ない

`RF-1-4`（**最も新しい**週を選ぶ）も、
「最初に見つかった週」を返す実装では通らないケースを作ってください。

## 停止点（契約より再掲）

- **merge しない。** PR を全緑にした時点で止まって報告する
- **`sync-connections` の `timeMax` を触らない**
- **`deliver-weekly` を触らない**
- migration を作らない。新テーブルを作らない
- 遡り上限8週を env や設定で可変にしない。**定数1つで固定する**

## 完了報告に必ず含めるもの

1. `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm run check:edge-types` の**実物の出力**
2. **陰性コントロールが「実装を壊すと落ちる」ことの実測。**
   例: `resolveWeekReference` をわざと「最初に見つかった週」に変えて RF-1-4 が赤になること、
   遡り上限を外して RF-1-5 が赤になることを1度ずつ確認し、出力を貼る
3. PR 番号と CI の全ジョブ結果（skip の有無・実行時間つき）
4. Vercel Preview のデプロイ結果と、**Preview の `/report` を実際に開いた結果**

## 併せて（**別コミットで可**）

`docs/contracts/slice-weekly-report.md` の **W-D1（当週固定）に一行追記**してください。

> 2026-08-31: 当週が0件のときのみ直近の実績週へ遡る（契約 `slice-report-fallback.md` RF-D2）。
> 既定が当週であることは変わらない。

`docs/spec/07_open_items.md` に**未判断として1件登録**してください（**勝手に確定させない**）。

> **カレンダーの未来の予定を取り込むか**（未判断・2026-08-31 登録）
> `sync-connections` と初回連携はどちらも `timeMax = now` で、未来の予定を一切取り込まない。
> `/report` はスライスRF のフォールバックで当面しのぐが、
> 「今週これから何があるか」を見せる機能を作るなら `timeMax` の判断が要る。
> S2 の allowlist・イベント量・「まだ起きていないこと」を Finding の材料にしてよいか、
> の3点が絡む。**人間の判断待ち。**
