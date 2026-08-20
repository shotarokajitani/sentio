# main のブランチ保護（2026-08-20 登録・**人間作業**・merge のブロッカー）

実行者: **梶谷さん**（GitHub の Settings。Claude は権限を持たず、また設定変更は人間関門）。
所要: 5〜10分。

## なぜ要るか（これが無いと merge できない理由）

`deploy.yml` の `verify` から `check:allowlist` を外した（2026-08-20・案A）。
実DBの列照会に変わっており、Supabase を起動しないこのジョブでは fail-closed で
必ず落ちて `deploy-migrations` に到達しないため。担当は `ci.yml` の `integration` に一本化した。

**その結果、`check:allowlist` は `ci.yml` でしか走らない。**
そして `ci.yml:2` は `on: [pull_request]` **のみ**である。

| 経路                          | ci.yml（integration / check:allowlist） | deploy.yml verify |
| ----------------------------- | --------------------------------------- | ----------------- |
| PR 経由の merge（squash 含む） | 走る                                    | 走る              |
| main への直 push              | **走らない**                            | 走る              |

つまり **main への直 push が可能な限り、その経路だけ S2 allowlist の機械的担保が消える**。
CLAUDE.md 絶対規則「S2テーブルに本文型カラムを追加しない」を守る仕掛けが片肺になる。
直 push の経路そのものを塞げば、この穴は無くなる。

**2026-08-20 時点の実測: main は未保護である。**

```
$ gh api repos/shotarokajitani/sentio/branches/main/protection
{"message":"Branch not protected","status":"404"}
$ gh api repos/shotarokajitani/sentio/rulesets
[]
```

## 設定手順（Rulesets を推奨）

GitHub の新しい方式。`Settings` → `Rules` → `Rulesets` → `New ruleset` → `New branch ruleset`。

| 設定項目                                                          | 値                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------ |
| Ruleset Name                                                      | `main-protection`                                      |
| Enforcement status                                                | **Active**                                             |
| Bypass list                                                       | **空のまま**（誰も迂回させない。管理者も含む）         |
| Target branches                                                   | `Include default branch`                               |
| **Restrict deletions**                                            | ✅ ON                                                  |
| **Block force pushes**                                            | ✅ ON                                                  |
| **Require a pull request before merging**                         | ✅ ON                                                  |
| └ Required approvals                                              | `0`（単独開発のため。レビュー体制ができたら 1 に上げる） |
| └ Dismiss stale pull request approvals when new commits are pushed | ✅ ON                                                  |
| **Require status checks to pass**                                 | ✅ ON                                                  |
| └ Require branches to be up to date before merging                | ✅ ON                                                  |
| └ Status checks that are required                                 | 下表の4件を追加                                        |

### 必須にするステータスチェック（4件）

`ci.yml` のジョブ名がそのまま context 名になる。**4件すべて**を追加すること。

| context 名       | 何を担保するか                                               |
| ---------------- | ------------------------------------------------------------ |
| `gitleaks`       | 秘密の混入検査                                               |
| `verify`         | typecheck / lint / unit / check:db-errors / check:caller-guard / eval:engine |
| `integration`    | **check:allowlist / check:schema** / RLS統合テスト ×3回        |
| `edge-functions` | check:edge-types（Edge Function の Deno 型検査）             |

> 一覧に出てこない場合は、一度 PR を作って `ci.yml` を走らせると候補に現れる。

**「Require a pull request」だけでは不十分**である点に注意。
それだけだと「PR は作ったが赤のまま merge する」が通ってしまい、
2026-08-19 に S-5 を赤い CI のまま完了扱いにした事故（run 32282055630）と同じ形が再発する。
**`Require status checks to pass` と4件の指定がセットで初めて意味を持つ。**

## 代替（Classic branch protection を使う場合）

`Settings` → `Branches` → `Add branch protection rule`。

| 設定項目                                                    | 値               |
| ----------------------------------------------------------- | ---------------- |
| Branch name pattern                                         | `main`           |
| Require a pull request before merging                       | ✅               |
| └ Require approvals                                         | OFF（0人でよい） |
| Require status checks to pass before merging                | ✅               |
| └ Require branches to be up to date before merging          | ✅               |
| └ 検索窓で `gitleaks` / `verify` / `integration` / `edge-functions` を追加 | 4件              |
| Do not allow bypassing the above settings                   | ✅（管理者も対象にする） |
| Allow force pushes                                          | OFF              |
| Allow deletions                                             | OFF              |

## 確認方法（設定後、梶谷さんが実行）

```
gh api repos/shotarokajitani/sentio/rulesets
```

`[]` でなくなっていること。Classic の場合は次で 404 でなくなること。

```
gh api repos/shotarokajitani/sentio/branches/main/protection
```

## 副作用として受け入れること

- **CI が赤い間は merge できなくなる。** これは意図した効果である
- `integration` ジョブは Supabase を Docker で起動するため、他より時間がかかる。
  merge のリードタイムがその分伸びる
- 緊急時に直 push で塞ぐ運用ができなくなる。必要になった場合は
  Ruleset を一時的に `Disabled` にする（`Evaluate` ではなく `Disabled`）。
  **戻すのを忘れると deploy.yml が片肺のまま走るので、戻すまでを1つの作業として扱う**
