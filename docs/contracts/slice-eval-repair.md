# スライスE — 評価スイートの修復（`eval:engine` が測っていないものを測る）

- 状態: **active**（2026-08-29 梶谷さん承認）
- 起草: 2026-08-29（検収者）
- 背景: `docs/reports/2026-08-29_eval_engineが測っていないもの.md`

## なぜやるか

`pnpm run eval:engine` は CI で毎回緑（`5 tests passed`）だが、
**契約と README が宣言している評価基準を測っていない。**

### 決定的な数字

仕込み陽性7件の `scanType` はこう分布している（`scripts/generate-synthetic-company.ts`）。

| signal | scanType |
| --- | --- |
| ① 発注間隔の伸長 | `trend` |
| ② 入金予定日の未着 | `deadline` |
| ③ 返信遅延 | `deviation` |
| ④ 深夜残業の漸増 | `trend` ← ①と同じ |
| ⑥ 新規問い合わせ比率の低下 | `deviation` ← ③と同じ |
| ⑦ 定例会議の消失 | `silence` |
| ⑧ 競合の採用ページ新設 | `external` |

**7件が5種類しかない。**
D1（`engine.test.ts:53`）は `c.scanType === signal.scanType` しか見ていないので、

**正しい型の候補が5件あれば、D1 は 7/7 検知と採点する。**
その5件が仕込みイベントと無関係でも通る。

`PlantedSignal` は `eventIds: string[]` を、`ScanCandidate` は `evidence_event_ids: string[]` を
**最初から持っている。** 突き合わせに必要なデータは揃っていて、**使っていないだけである。**

### 併せて

- `eval/golden/**`（12ケース）は `engine.test.ts` から**一度も読まれていない**
- `eval/README.md` が宣言する**ルーブリック採点は実装が無い**。Evaluator はこのスイートで動かない
- `eval/golden/real-diseno/meta.json` に、**過去に実際に起きた誤採点**が記録されている

> テンプレ差し込みによる Day0 を pass と誤採点した。LLM非使用（生成時間135ms）が証拠。
> 実データ67件を保有しながら一切プロンプトに含めていなかった。

  同ファイルの `evaluator_must_run` / `generation_time_min_ms` / `day0_must_contain` は
  **機械検査可能な形で書かれているのに、検査するコードが無い。**

## 決定

| # | 論点 | 決定 |
| --- | --- | --- |
| **E-D1** | D1 の判定 | **`evidence_event_ids` と `PlantedSignal.eventIds` の交差で判定する。** 型の一致だけで検知扱いにしない |
| **E-D2** | D2 の誤検知定義 | **証拠が仕込み陽性のイベントを1つも含まない候補**を誤検知と数える。型ベースをやめる |
| **E-D3** | `eval/golden/**` | **読む**（2026-08-29 承認）。ローダを書いて `meta.json` を実際に読み、仕込みの型・件数と突き合わせる。消す案は採らない（`real-diseno` の学びが失われるため） |
| **E-D4** | ルーブリック採点 | **今回は実装しない。** README の記述を実態に合わせて落とす。Evaluator を回すのは LLM を伴うのでスライスを分ける |
| **E-D5** | Scanner を直すか | **直さない。** このスライスは**測り方だけ**を直す。測った結果が悪くても、Scanner の修正は別の判断 |

## 受入基準

| # | 基準 | 検証 |
| --- | --- | --- |
| E-1-1 | D1 が `evidence_event_ids` と `eventIds` の交差で検知を判定する | unit |
| E-1-2 | **同じ `scanType` の仕込み2件を、候補1件で2件とも検知扱いにしない** | unit（**陰性コントロール。いま起きている誤りそのもの**） |
| E-1-3 | 仕込みイベントを1つも含まない候補は、型が合っていても検知に数えない | unit（**陰性コントロール**） |
| E-2-1 | D2 の誤検知が「証拠が仕込み陽性を含まない候補」で数えられる | unit |
| E-2-2 | 陰性コントロール⑤（季節性）は引き続き検知されない | 既存検査を残す |
| E-3-1 | `eval/golden/**` の `meta.json` を**実際に読む**。ケース数・`type`・`scanType` が仕込みと一致することを検査する | unit |
| E-4-1 | `real-diseno` の `evaluator_must_run` / `generation_time_min_ms` / `day0_must_contain` を**読んで検査する検査器を実装する** | unit |
| E-4-2 | **Day0 の出力成果物が無いときは fail する。** 黙って pass しない（**fail-open を潰す**。`tests/integration/report-page.test.ts` の `mode === "fail"` ガードと同じ形） | unit（**陰性コントロール**） |
| E-5-1 | `eval/README.md` の記述が実装と一致する（ルーブリック採点の記述を落とす） | 目視 |

## **停止点（最重要）**

**直した D1 / D2 を現行の Scanner に当てた結果を、先に報告すること。**

いまの D1 は 7/7 と採点している可能性が高い。**証拠まで見たら 3/7 かもしれない。**

- **その数字を隠さない。契約の合格線（陽性6件以上・誤検知2件以下）に届かなくてよい。**
- **Scanner を直して数字を合わせにいかない**（E-D5）。それは別の判断である
- 届かない場合、**このスライスは「CI を赤にする」ことが成果**である。
  `docs/contracts/slice-state-repair.md` の S-5-6（修復前の赤の確認・人間関門）と同じ形

**修復前の実測値を報告してから、CI をどうするかを人間が決める。**
勝手に `skip` にしない。勝手に閾値を下げない。

## 修復後の実測（2026-08-29・**停止点の報告**）

**直した D1 / D2 を現行の Scanner に当てた結果。Scanner は直していない（E-D5）。**

### D1 = **5/7**（合格線6に届かない）

```
D1 実測: 5/7 検知
  ✓ signal 2 ← 候補#10（証拠 1件）
  ✓ signal 3 ← 候補#7（証拠 3件）
  ✓ signal 6 ← 候補#8（証拠 4件）
  ✓ signal 7 ← 候補#6（証拠 1件）
  ✓ signal 8 ← 候補#11（証拠 1件）
  ✗ signal 1 order_interval_elongation（scanType=trend）を検知できていない
  ✗ signal 4 overtime_creep（scanType=trend）を検知できていない
```

**直す前は 7/7 だった。** 差の2件はどちらも `trend` として仕込んだものである。

落ちた2件の中身は同じではない。**ここが判断の分かれ目になる。**

| signal | 実際に起きていること |
| --- | --- |
| ① `order_interval_elongation` | 仕込みイベントを参照する候補は**すべて `deviation`**で、内容も `Revenue 50000 outside range [70500, 130500]`。**発注間隔の伸長としては見ていない**（金額の外れ値として拾っているだけ） |
| ④ `overtime_creep` | 候補の説明は `Overtime hours increasing: 1 → 3 (5 consecutive points)` で、**現象は正しく捉えている**。ただし `scanType` が `trend` ではなく **`deviation`** と名乗っている |

**④は「見つけているが名前が違う」、①は「別のものとして見ている」。**
参考値として、`scanType` を見ずに証拠の交差だけで数えると **7/7** になる。
どちらを D1 の定義とするかは設計判断であり、契約は E-1-3（「型が合っていても
証拠が無ければ数えない」）と書いているので、**型と証拠の両方を必要条件とした**。

### D2 = **誤検知1件**（合格線2以下を満たす）

```
D2 実測: 誤検知 1件 / 候補 12件
  誤検知: scanType=trend 証拠=txn_normal_0001,txn_normal_0002,txn_normal_0003
```

**唯一の `trend` 候補が、正常データ（`txn_normal_*`）に出ている。**
直す前の型ベース定義では誤検知0件と採点されていた。

### E-4 = **fail**（Day0 成果物が存在しない）

```
E-4 実測: Day0 成果物の検査に問題あり
  - Day0 の出力成果物が無い。検査対象が存在しない状態を pass にしない（E-4-2）
```

`real-diseno/meta.json` の `evaluator_must_run` / `generation_time_min_ms` /
`day0_must_contain` を検査する器は実装した。**当てる成果物が無い。**
これを pass にすると `a2_misjudgment`（テンプレ差し込みの Day0 を pass と誤採点）と同じ形になる。

### したがって `eval:engine` は赤である

**赤の理由は閾値ではなく実測値である。** 契約の停止点どおり、
Scanner を直して数字を合わせにいっていない。閾値も下げていない。skip にもしていない。

**波及**: `vitest.config.ts` の `include` は `tests/**/*.test.ts` なので、
`tests/eval/engine.test.ts` は `ci.verify` の unit 実行にも含まれる。
したがって **verify ジョブも同じ2件で赤になる**（他の 54ファイル・545テストは緑）。
`typecheck` / `lint` / `check:db-errors` / `check:caller-guard` / `check:ci-coverage` /
`check:edge-types` はすべて exit=0。

**CI をどう扱うかは人間の判断**（このまま赤を現在地として残すか、Scanner を直す別スライスを立てるか）。

## 非スコープ

- Scanner（`src/sense/scanner.ts`）の検知ロジックの変更
- Investigator / Evaluator / Day0 を評価スイートで動かすこと（LLM を伴う。別スライス）
- 合成会社のフィクスチャ（`scripts/generate-synthetic-company.ts`）の変更
- prompts/ の変更

## この契約が閉じたら分かること

**「エンジンが実際どこまで検知できるのか」の実測値。**

今日「出力が薄いのは②データ量であって③文面ではない」と判断したが、
その根拠は**メール1通の目視**だった。回帰を止める仕組みが後ろに無い。
このスライスは、その仕組みを作る前提として**現在地を数字にする。**
