# check:ci-coverage のカバレッジと残存制約

`scripts/check-ci-coverage.ts`（契約 S-5-7）が**どこまで守れて、どこから守れないか**を明示する。
黙って残った穴は「守られている」と誤読されるため、`hooks-coverage.md` と同じ形でここに顕在化させる。

## なぜ作ったか

「検査器はあるが CI で落ちない」形が3度出た。

| #   | 事象                              | 形                                          | 担当                                 |
| --- | --------------------------------- | ------------------------------------------- | ------------------------------------ |
| 1   | deno check 28件                   | 検査器はあるが **CI に載っていない**        | **この検査器**                       |
| 2   | S-5-1 `check:schema`              | CI で走って赤なのに完了報告された           | **この検査器では捕まらない**（後述） |
| 3   | `deploy.yml` の `check:allowlist` | ci.yml と deploy.yml の**分担がずれている** | **この検査器**                       |

#1 と #3 は **CI が赤にならない**ことが問題の本体なので、run の色を見る監視では原理的に届かない。
逆に #2 は配置の照合では届かない。**両方要る。**

## 何を突合しているか

正本は `docs/checklists/ci-coverage.yml`。突合は4方向ある。

1. **宣言 × ワークフローの実物**（`.github/workflows/*.yml` を YAML としてパースし、
   `<ファイル名>.<ジョブ名>` 単位で `steps[].run` を走査する）
2. **宣言 × `package.json` の `scripts`**（両方向の集合差）
3. **宣言 × `scripts/check-*.ts` の実ファイル**（両方向の集合差）
4. **配置禁止**。`requires: live-db` / `requires: deno` から機械的に導出する
   （前提を満たさないジョブに載っていたら `forbidden`）。
   `requires` が空の検査器は `must_not_run_in` で明示する

判定は9種類: `missing` / `forbidden` / `unknown-job` / `inconsistent-declaration` /
`undeclared-in-workflow` / `undeclared-script` / `dangling-declaration` /
`undeclared-script-file` / `dangling-file`。

**単純な集合包含では #3 を「載っているから OK」と誤判定する。**
`check:allowlist` は `ci.integration` に載っていなければならず、かつ
`deploy.verify` に載っていてはいけない。配置は集合ではなく写像として扱う。

## 守れない範囲（設計上の限界。これは仕様であって不具合ではない）

1. **赤い CI を読まずに完了報告する経路は止められない（#2）。**
   この検査器は「配置」しか見ない。配置が正しくても、走った結果が赤なのを
   人間（または私）が読まなければ同じ事故が起きる。担保は CLAUDE.md 常設指示
   「CI監視の定型化」であり、**規則は既に存在し、守られていなかった**。
   規則の追加ではなく履行の問題として扱う

2. **`scripts/check-*.ts` 以外の場所に置かれた検査器は見えない。**
   実例が2つある。`ci.yml` の
   「Resend の設定が CI に載っていないことを確かめる」（契約 S-2-10）と
   「Probe Edge Runtime reachability」（契約 S-5-2）は、
   **ワークフローの `run` に直書きされたシェルの検査器**で、
   `package.json` にも `scripts/` にも現れない。
   これらが将来削られても、この検査器は気づかない。
   `scripts/check-*.ts` に切り出すか、宣言に別の形で載せるかは未判断

3. **検査器が「中身のある検査をしているか」は見ない。**
   1行 log を出して緑を返すだけの検査器も、配置が正しければ通る
   （`check:allowlist` が実際にそうなっていた）。
   中身の担保は各検査器自身のユニットテスト（陽性・陰性コントロール）の責任である

4. **`on:` のトリガは見ない。**
   `ci.yml` が `on: [pull_request]` のみで main 直 push では走らないことは、
   この検査器では検出しない。ブランチ保護（`docs/runbooks/2026-08-20_branch-protection.md`）
   で塞ぐ前提になっている。トリガの検査を足すかは未判断

5. **ローカル専用ではない。** hooks と違い CI で走る（`ci.verify`）。
   ただし**この検査器自身を CI から外す**ことはできる。
   それは宣言に自分自身（`check-ci-coverage`）が入っていることで捕まる
   — 外せば `missing` を吐いて赤になる

## 変更時の作法

宣言（`docs/checklists/ci-coverage.yml`）またはスクリプトを変更したら、
**陽性・陰性の両コントロールを実物出力付きで残す**こと。

- 陽性: 正しい配置で `findings` が0件になること
- 陰性: 少なくとも #1（`missing`）と #3（`forbidden`）が再現すること

`tests/unit/check-ci-coverage.test.ts` が19ケースで自動検証する。
**実物のワークフローだけを入力にすると、全部緑のとき検査器の故障が見えない**ので、
固定フィクスチャでの陰性コントロールを必ず持つこと。

実物での再現も1度は行うこと（2026-08-20 実測）。

```
# deploy.verify に check:allowlist を戻して実行
$ pnpm run check:ci-coverage
check:ci-coverage — 配置の不一致 1件:

  [forbidden] check-allowlist: deploy.verify は requires: live-db を満たさないのに
  pnpm run check:allowlist を実行している
exit=1
```
