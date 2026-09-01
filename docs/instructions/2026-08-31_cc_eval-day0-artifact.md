# Claude Code への指示文（スライスE の E-4 決着）— 2026-08-31

**この本文をそのまま Claude Code に貼る。** PowerShell には貼らない。
**PR #51 の続き**であり、新しいブランチを切らない。

---

PR #51（スライスE）の E-4 の扱いが決まりました。**梶谷さん承認済みです。**

## 決定

**合成会社で Day0 を1回走らせ、その成果物を commit する。CI は成果物を読んで検査するだけにする。**

`eval/golden/real-diseno/` は**検査対象にしない。そのまま残す。**
実会社の Day0 本文は S1 の生成文で、金額・件数・取引先が入る。**リポジトリに置かない。**
`a2_misjudgment` の記録は学びとして残す価値があるので消さない。

**採らなかった案と理由も contract に書き残すこと。**

- skip / 別スイートへ退避 → `a2_misjudgment` の再発防止が消える。スライスEの目的そのものを捨てる
- CI で毎回 Day0 を実走 → LLM 依存で CI が不安定になり、赤が読み流される。
  「常設の赤を作らない」判断（PR #51 で確定済み）と衝突する

## やること

### 1. 成果物を作る生成器（**CI では走らせない**）

```
scripts/generate-day0-artifact.ts
```

- `scripts/generate-synthetic-company.ts` の合成会社を入力にする。**実データを使わない**
- **本物の Day0 経路を通す。** テンプレ差し込みで作らない
  （それをやったのが `a2_misjudgment` そのものです）
- 出力: `eval/golden/synthetic-day0/artifact.json`

`artifact.json` に必ず入れるもの:

```
generated_at        ISO8601
model               実際に使ったモデル名
generation_time_ms  実測値。ストップウォッチを後から書き換えない
evaluator_ran       Evaluator を実際に通したか（true/false）
prompts_hash        後述
blocks              生成された Day0 ブロック（本文込み）
```

### 2. `prompts_hash`（**ここが肝。これが無いと成果物がハリボテ化する**）

`prompts/` 配下の**全ファイルを相対パスでソートし、パスと内容を連結して sha256** を取る。
アルゴリズムは `scripts/` 側と検査器側で**同じ関数を共有する**（二重実装しない）。

検査器は、`artifact.json` の `prompts_hash` と**いま計算したハッシュが一致すること**を検査する。

**不一致なら赤にする。** メッセージは「プロンプトが変わったのに Day0 成果物が古い。
`pnpm run eval:day0:regen` で作り直してください」とする。

これが無いと、プロンプトを変えても古い成果物が通り続けます。
`check:allowlist` が「1行 log を出して緑を返すだけ」になっていたのと同じ形です。

### 3. 期待値（`eval/golden/synthetic-day0/meta.json`）

**`real-diseno/meta.json` からコピーしない。** 合成会社に実際に含まれるものから導く。

- `evaluator_must_run: true`
- `generation_time_min_ms: 2000`
- `day0_must_contain`: 合成会社の**実際の**データ源とシグナルに出てくる語で書く。
  何を選んだか、なぜそれが「LLM を通った証拠」になるかを meta.json のコメントか
  契約に**日本語で書き残す**こと

### 4. 検査器（`tests/eval/` 側）

- `artifact.json` が**無いときは fail する**（E-4-2 を維持。**skip にしない**）
- `prompts_hash` 不一致で fail
- `evaluator_ran !== true` で fail
- `generation_time_ms < 2000` で fail
- `day0_must_contain` の各語が該当ブロックに含まれないと fail

## 陰性コントロールを必ず書く（**これが本体です**）

固定フィクスチャで、次が**それぞれ赤になること**を自動検証してください。
実物の成果物だけを入力にすると、全部緑のとき検査器の故障が見えません
（`.claude/rules/ci-coverage.md` に同じことが書いてあります）。

- 成果物が**無い**とき → fail（黙って pass しない）
- `prompts_hash` が**古い**とき → fail
- `evaluator_ran: false` のとき → fail
- `generation_time_ms: 135` のとき → fail（**`a2_misjudgment` の再現そのもの**）
- `day0_must_contain` の語が**欠けている**とき → fail

## D1 = 5 の扱いは変えない

PR #51 で確定済みです。`expect(detected).toBe(5)` のまま。
**このコミットで Scanner にも閾値にも触らない。**

## 停止点

- **merge しない。** 全緑にした時点で止まって報告する
- `eval/golden/real-diseno/` を**編集しない・削除しない**
- 実会社（ディセーノ）のデータを成果物に**一切入れない**
- 生成器を CI のジョブに載せない（`docs/checklists/ci-coverage.yml` の宣言にも入れない）
- 本番 Ref `kwpldqbnkraftaahnpev` への CLI 直接操作をしない

## 詰まりうる点（先に言っておきます）

生成器は LLM を呼ぶので `ANTHROPIC_API_KEY` が要ります。
**Vercel 側で `anthropic-workspace-id is required when authenticating with an
identity-linked API key` が出た事例があります**（2026-08-30・CSV 取り込み）。
ローカルで同じエラーが出たら、**鍵の値には触らず**、
エラー全文を貼って止まってください。梶谷さんに workspace 発行の鍵を作ってもらいます。

## 完了報告に必ず含めるもの

1. `pnpm typecheck` / `pnpm lint` / `pnpm run eval:engine` の**実物の出力**
2. **生成器の実行ログ**（`generation_time_ms` の実測値を含む）。
   2000ms を下回ったらそれは**テンプレ差し込みの疑い**です。
   下回った場合は commit せず、原因を報告してください
3. 陰性コントロール5本が**実際に赤になること**の実物出力
4. `prompts/` を1文字変えて `eval:engine` が赤になり、再生成で緑に戻ることの実測
5. PR #51 の CI 全ジョブ結果（skip の有無・実行時間つき）
