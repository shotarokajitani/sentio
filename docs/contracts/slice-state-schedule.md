# スライスSB — State 層を毎日回す（`state-baselines` に呼び出し元が無い）

- 状態: **active**（2026-09-03 梶谷さん承認）
- 起草: 2026-09-03（検収者）
- 背景: `docs/reports/2026-09-03_Finding が0件である構造的な理由.md`
- 前提: スライスCD クローズ済み（`docs/contracts/slice-cron-dispatch.md`）

## なぜやるか

**アーキテクチャは Ingest → State → Sense → Act だが、動いている系から State が丸ごと抜けている。**

自動で回っている経路はこれだけである。

```
cron(00020) → sync-connections                     … Ingest
cron(00028) → dispatch-daily → run-sense → scan → investigate → deliver-pulse
                                                    … Sense → Act
```

`run-sense/index.ts:52` は `scan` を、`:132` は `investigate` を叩く。
**`state-baselines` を呼ぶ行は、リポジトリのどこにも無い。**
`_shared/dispatch.ts:107` も `run-sense` → `deliver-*` の2本だけである。

### 実測（2026-09-03・CC 測定）

本番の `baselines` に存在する行は**1件だけ**。

```
metric_key  granularity  is_established  min_obs  stats->>'count'  最終更新
revenue     event        false           5        null             2026-08-27 09:59:46+00
```

**`schedule_interval` の行が無い。** ところが `state-baselines/index.ts:99-114` は
その行を upsert する。**コードはあるが、一度も走っていない。**

その半分（`schedule_interval`）が足されたのは 2026-08-31 で、
最終更新の 08-27 はそれより前である。**追加してから今日まで、本番で1度も実行されていない。**

### これが塞いでいるもの

- **走査6（途絶・会社全体）** は `is_established` なベースラインを前提にする。
  行が無いので**回らない**（`scan.ts:258-260`）
- **走査1（乖離）** も `revenue` ベースラインを前提にする。
  こちらは別の原因（`metrics.revenue` を書く経路が無い）でも塞がっているが、
  **仮にそれを直しても、この経路が無ければ成立しない**

**検出器を足しても、State が更新されなければ発火しない。** 対になる半分がここである。

## 決定

| #         | 論点                                | 決定                                                                                                                                                                                                                                                      |
| --------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SB-D1** | どこで回すか                        | **`dispatch-daily` の中、`run-sense` を呼ぶ直前。** 新しい cron を張らない。契約CD の CD-D2「**cron はディスパッチャだけを叩く**」を守る。ディスパッチャ内に置くことで **State → Sense の順序が構造的に保証される**（別 cron にすると順序が運任せになる） |
| **SB-D2** | `state-baselines` が失敗したとき    | **`run-sense` と `deliver-pulse` を止めない**（CD-2-4 と同じ形）。ただし**失敗として集計に載せ、`failed` に加算する**。1件でも失敗があれば non-2xx（CD-2-2 は変えない）                                                                                   |
| **SB-D3** | 週次（`dispatch-weekly`）でも回すか | **回さない。** 日次で毎日走れば足りる。週次は配信だけを持つ                                                                                                                                                                                               |
| **SB-D4** | 他の `state-*` も回すか             | **回さない。** `state-narratives` の呼び出し元は `07_open_items.md` に「**いま決めない**」として登録済み（2026-08-24）。`state-summary` / `state-memory-packet` も同様に触らない。**このスライスは `state-baselines` 1本だけ**                            |
| **SB-D5** | `revenue` の定義                    | **触らない。** `metrics.revenue` を書く経路が無い件は別の判断であり、報告に未判断として書いてある。**ここで `amount` を `revenue` に読み替えない**                                                                                                        |
| **SB-D6** | 呼ぶ順序と対象の絞り込み            | **既存のスキップ判定（連携ゼロ / 宛先なし）の後に置く。** 判定の前に出すと、配信対象でない会社にも State 更新が走る。**ただしこれは限界である**（後述）                                                                                                   |

## 実装の形

`supabase/functions/_shared/dispatch.ts` の `runDispatch` を変える。

```
DispatchSummary に state_failed: number を足す

for (const target of targets) {
    …既存のスキップ判定（hasConnection / email）…

    if (kind === "daily") {
+     const state = await deps.invoke("state-baselines", { company_id: target.companyId });
+     if (!state.ok) { summary.state_failed++; summary.failed++; }

      const sense = await deps.invoke("run-sense", { company_id: target.companyId });
      …
    }
    …
}
```

**`deps.invoke` の形は変えない。** `index.ts` 側は関数名の文字列が1つ増えるだけである。

## 受入基準

### SB-1 系: 順序と対象

| #      | 基準                                                                                    | 検証                                                     |
| ------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| SB-1-1 | 日次で **`state-baselines` → `run-sense` → `deliver-pulse` の順**に呼ぶ。順序を固定する | unit（**呼び出し順を配列で突き合わせる。集合で見ない**） |
| SB-1-2 | **週次では `state-baselines` を呼ばない**                                               | unit（**陰性コントロール。SB-D3**）                      |
| SB-1-3 | 連携ゼロの会社では `state-baselines` を**呼ばない**                                     | unit（**陰性コントロール**）                             |
| SB-1-4 | 宛先が取れない会社では `state-baselines` を**呼ばない**（SB-D6）                        | unit（**陰性コントロール。限界を意図として固定する**）   |

### SB-2 系: 失敗の扱い

| #      | 基準                                                                                                       | 検証                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| SB-2-1 | `state-baselines` が失敗しても、**`run-sense` と `deliver-pulse` は走る**                                  | unit（**陰性コントロール。State の失敗で配信を止めない**） |
| SB-2-2 | `state-baselines` の失敗を `state_failed` に数え、**`failed` にも加算する**。成功だけ数えて 200 を返さない | unit（**陰性コントロール。fail-open を潰す**）             |
| SB-2-3 | 集計に**メールアドレスも会社名も出さない**（CD-2-3 を維持）                                                | unit（**陰性コントロール**）                               |

### SB-3 系: 壊してはいけないもの

| #      | 基準                                                                                                                                         | 検証                                          |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| SB-3-1 | `state-baselines` の**実装を1行も変えない**                                                                                                  | git diff                                      |
| SB-3-2 | `run-sense` / `deliver-pulse` / `deliver-weekly` の**シグネチャと挙動を変えない**                                                            | 既存テストが通ること                          |
| SB-3-3 | **cron を増やさない・書き換えない**（`00020` / `00028` に触らない）                                                                          | git diff（`supabase/migrations/` に差分なし） |
| SB-3-4 | 既存の集計キー（`companies` / `delivered` / `skipped_*` / `failed` / `sense_failed`）の**意味を変えない**。足すのは `state_failed` の1つだけ | 既存テストが通ること                          |
| SB-3-5 | `dispatch-*` が `resolveCaller` を通る経路を変えない（ADR-0002）                                                                             | `check:caller-guard`                          |
| SB-3-6 | `check:endpoint-callers` の宣言に `state-baselines` の呼び出し元を追加する                                                                   | **未充足**（下記）                                            |

> **SB-3-6 は未充足である（2026-09-03・梶谷さん判断で別登録）。**
>
> `check:endpoint-callers` は **Next.js 専用**で、宣言が `route: src/app/api/…` /
> `endpoint: /api/…` を要求し、走査も `src/` だけ（`collectSources(root = "src")`）。
> 不変条件はテストにも固定されている（`tests/unit/check-endpoint-callers.test.ts:222-227`）。
> `state-baselines` は Edge Function で、呼び出しも関数名の文字列なので、
> **宣言に足した瞬間に既存テストが赤くなる。**
>
> 検査器を Edge 対応に広げるか専用の検査器を新設するかは判断が要るため、
> `docs/spec/07_open_items.md`「Edge Function の呼び出し元を機械で守れない」に登録した。
> **このスライスが直した形は、機械ではまだ守られていない。**

## 停止点

- **merge しない。** PR を全緑にした時点で止まって報告する
- **cron を増やさない**（SB-D1）
- **他の `state-*` を呼ばない**（SB-D4）
- **`state-baselines` の中身を直さない**（SB-D5）。`revenue` の定義は別の判断
- **`MIN_OBS = 5` を下げない。** 成立しなかったら「観測が足りない」という事実がそのまま要る
- 本番 Ref `kwpldqbnkraftaahnpev` への CLI 直接操作をしない

## 既知の限界（**最初から書いておく**）

1. **宛先が取れない会社の State は更新されない**（SB-D6）。
   このディスパッチャは配信のためのものであり、State の更新をそこに相乗りさせている。
   **配信対象と State 更新対象が同じであるという前提**が入った。
   会社が増えて「連携はあるが配信は止めている」会社が出た時点で、この前提は崩れる。
   **その時が切り分けの合図である**
2. **`state-baselines` は1社ずつ直列に呼ばれる。** 契約CD の限界1（1関数で全社を直列）に
   1社あたり1往復が増える。会社数が増えたときの分割は、CD の限界と同じ場所で同時に直す
3. **これは検知を増やす変更ではない。** ベースラインが成立するようになるだけで、
   **走査6 が実際に発火するかは別**である（`scan.ts:251-257` が明記するとおり、
   会議が密な会社では平常の間隔が短く、3倍でもほぼ出ない）。
   **「State を回したので検知が増える」と書かないこと**

## 非スコープ（**やらない**）

- `metrics.revenue` を書く経路を作ること（別の判断・報告に登録）
- `state-narratives` / `state-summary` / `state-memory-packet` の起動（`07_open_items.md`）
- `entities` 行の生成（シリーズ単位のベースライン）
- 走査の閾値変更。**実測で「条件を満たしていない」ことが分かっているので、下げる根拠が無い**
- 異常が無い日に何を出すかの設計（別スライス。報告の「問いが変わった」節）

## この契約が閉じたら分かること

**「予定の日が5日ぶん取れているのか。」**

`schedule_interval` ベースラインが成立すれば、走査6 が**初めて動きうる状態**になる。
成立しなければ、**取り込んでいる予定の日数がそもそも足りない**ことが分かる
（`sync-connections` が `timeMax = now` で未来を取らない件と繋がる可能性がある。
それは `07_open_items.md`「カレンダーの未来の予定を取り込むか」に登録済み）。

**どちらに転んでも、いまより1つ多く分かる。**
いまは「回っていないので何も分からない」状態である。

## 検証（**merge 後・翌朝の自動実行で見る**）

翌朝 07:00 JST（22:00 UTC）のパルスが届いた後に、`baselines` を見る。

- `schedule_interval` の行が**存在すること**
- その `updated_at` が**当日であること**
- `is_established` と `stats->>'count'` を記録すること（**成立していなくてよい。数が要る**）
- `revenue` の行の `updated_at` も**当日に更新されていること**（呼ばれた証拠）

**手で叩いて確かめない。** 手動実行では「自動で回るようになったか」が確かめられない。
契約CD で「唯一の検知は毎朝届くはずのものが届かないこと」と書いたのと同じ理由である。
