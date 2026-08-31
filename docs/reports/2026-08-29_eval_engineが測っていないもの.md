# `eval:engine` は、契約が言う評価基準を測っていない（2026-08-29・検収者）

**「エンジンが実際どこまで言えるのか」を確かめようとして、確かめる道具の方が壊れていた。**

`pnpm run eval:engine` は CI で毎回緑になっている（`5 tests passed`）。
だがこれは**契約とREADMEが宣言している評価基準を測っていない。**

---

## 1. D1（検知率）は、実際には検知を見ていない

`tests/eval/engine.test.ts:53-77`。**「7件の陽性signalのうち6件以上を検知する」**という検査。

```ts
const hasCandidate = candidates.some((c) => {
  if (signal.scanType === "deviation" || ... || signal.scanType === "external") {
    return c.scanType === signal.scanType;   // ← scanType を比べているだけ
  }
  return false;
});
```

**候補が「同じ scanType であること」しか見ていない。**
すぐ上のコメントはこう書いている。

> Check if any candidate matches this signal's scan type **and references its events**

**events は一度も参照されていない。** 実装がコメントに追いついていない。

帰結:

- 仕込み陽性のうち2件が同じ scanType を持てば、**候補1件で2件とも検知扱いになる**
- 仕込みと無関係なイベントから出た候補でも、**型さえ合えば検知扱いになる**

**つまり D1 が測っているのは「scanner が各型の候補を1つ以上吐いたか」であって、
「仕込んだ7つの異常を見つけたか」ではない。**

`detectedTypes`（`:56`）は計算されるだけで**一度も使われない**。
検査が途中で緩められた痕跡に見える。

## 2. D2（誤検知）はほぼ反証不能

`:80-89`。仕込み陽性が持つ scanType の集合に**含まれない**候補を誤検知と数える。
陽性7件が5種類の scanType をほぼ覆っているので、**残る型がほとんど無い。**

`deviation` の候補を500件吐く scanner でも、**誤検知は0件と採点される。**

## 3. 陰性コントロール⑤だけは本物

`:91-102` は `evidence_event_ids` が `txn_normal` で始まるかを見ている。
**3つの検査のうち、証拠まで見ているのはここだけ。**

## 4. `eval/golden/**` は誰も読んでいない

`eval/golden/` に12ケース分の `meta.json` がある（陽性7・陰性4・実会社1）。
**`engine.test.ts` は `eval/golden` を一度も読まない。**
import は `generateSyntheticCompany`（`scripts/`）と `runScan`（`src/sense/`）の2つだけで、
合成会社は**その場でコード生成**している。

golden の `expected` は、機械検査されない**ただの文書**である。

## 5. README が宣言している「ルーブリック採点」は存在しない

`eval/README.md`:

> 実行: `pnpm run eval:engine` → 検知率・誤検知率（陰性コントロール含む）・**ルーブリック採点**を出力

**ルーブリック採点のコードが無い。** Evaluator（5基準）はこのスイートで一度も動かない。
`.claude/skills/synthetic-company` の評価基準
「全Findingが**Evaluator5基準pass**」も、同様に測られていない。

Investigator（Planner→Generator→Evaluator）も、Day0 も、LLM も、**このスイートは一切通らない。**
動いているのは `runScan`（Scanner・LLMなし）だけである。

## 6. 一番効くのは、golden に残っている過去の誤採点の記録

`eval/golden/real-diseno/meta.json`:

> **`a2_misjudgment`**: テンプレ差し込みによる Day0 を pass と誤採点した。
> LLM非使用（**生成時間135ms**）が証拠。**実データ67件を保有しながら一切プロンプトに含めていなかった。**

同じファイルには、それを二度と起こさないための機械検査可能な条件が書かれている。

```json
"evaluator_must_run": true,
"generation_time_min_ms": 2000,
"day0_must_contain": { "initial_hypothesis": ["入出金", "カレンダー", "具体的金額or件数or傾向"] }
```

**この3つを検査しているコードは存在しない。**
「テンプレを差し込んだだけの Day0 を pass と採点した」事故の再発防止策が、
**書かれただけで実装されていない。**

---

## なぜこれが今日の問いに直結するか

今日ずっと「出力が薄いのは②データ量か③文面か」を切り分けようとしてきた。
7月の合成会社 Day0（アオバ製作所）が厚かったので**③ではない**と判断した。

**その判断の土台が弱い。** `eval:engine` は Day0 にも Evaluator にも触れておらず、
**「厚く見えた Day0 が本当に LLM を通っていたか」を機械的に保証する仕組みが無い。**
`a2_misjudgment` は、まさにそれを人間が見誤った記録である。

**「エンジンは書ける」という今日の結論は、メール1通の目視に依存している。**
それ自体は正しい観察だが、**回帰を止める仕組みが後ろに無い。**

## 提案（未着手・人間の判断待ち）

| # | 内容 |
| --- | --- |
| E-1 | D1 を `evidence_event_ids` まで見る形に直す。仕込みイベントと突き合わせる |
| E-2 | D2 の誤検知定義を、型ではなく**証拠が仕込みと無関係であること**にする |
| E-3 | `eval/golden/**` を実際に読む。読まないなら削る（**どちらかにする**。読まれない期待値は嘘になる） |
| E-4 | `real-diseno` の `evaluator_must_run` / `generation_time_min_ms` / `day0_must_contain` を検査する |
| E-5 | README の「ルーブリック採点」を実装するか、記述を落とす |

**E-1 と E-4 が最優先。** どちらも「一度実際に起きた誤りを、二度目に自動で止める」ためのものである。
