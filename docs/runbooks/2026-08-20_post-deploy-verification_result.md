# deploy #27 の事後検証（`00023` / `00024`）— 実測結果

実施日: 2026-08-20 / 実施者: 梶谷 / 判定: 検収者
対象: 本番 / 手順: `docs/runbooks/2026-08-20_post-deploy-verification.sql`
前提: deploy #27（`7a455be` / PR #31）完了後

## 判定: **Q1〜Q4 すべて OK**

`00023` / `00024` は本番に意図どおり載っている。

## なぜ SQL で確かめたのか

契約の受入基準は当初「`00023` の `server_version` NOTICE と `00024` の移行行数 NOTICE を
**deploy ログから引用する**」だった。**これは満たせない。**
`supabase db push` はサーバ側の `NOTICE` を出力せず、deploy #27 の `Apply migrations` は
**全17行で NOTICE がゼロ**だった（実測）。

2026-08-20 に**案A**（デプロイ後の SQL 検証）を採用し、受入基準を差し替えた。
本ファイルはその最初の実施記録である。

## Q1. PostgreSQL バージョン（`00023:38` の NOTICE の代替）

| 項目 | 実測 |
| --- | --- |
| `server_version` | **17.6** |
| `server_version_num` | **170006** |
| verdict | **OK**（`>= 150000`） |

停止点0（`docs/checklists/env-diff.md`）の実測値と一致する。
`00023` の版ガード（`server_version_num < 150000` で `RAISE EXCEPTION`）は発火していない。

## Q2. `00023` の索引（`00023:82` の NOTICE の代替）

| 項目 | 実測 |
| --- | --- |
| `index_name` | `idx_baselines_natural_key` |
| `is_unique` | **true** |
| `nulls_not_distinct` | **true** |
| verdict | **OK** |

定義:

```sql
CREATE UNIQUE INDEX idx_baselines_natural_key ON public.baselines
  USING btree (company_id, metric_key, entity_id, granularity)
  NULLS NOT DISTINCT
```

**`nulls_not_distinct = true` が要点。** これが false だと `entity_id` が NULL の行を
一意制約が捕まえられず、自然キーの意味が成立しない。PostgreSQL 15 以降の構文で、
本番が 17.6 なので通った。

**列順は `(company_id, metric_key, entity_id, granularity)`。**
リポジトリの `00023` および `env-diff.md` の記述と一致する
（2026-08-20 に検収者が「`(company_id, entity_id, metric_key, granularity)`」と
書いたのは誤記であり、実物を書き換えないと判断したのは正しかった。
UNIQUE の意味論も `ON CONFLICT` の推論も列集合で決まるため、いずれにせよ実害は無い）。

## Q3. `00024` の移行行数（`00024:41` / `:108` の NOTICE の代替）

| 項目 | 実測 | 期待 |
| --- | --- | --- |
| `total_rows` | **0** | 0 |
| `still_alert_deferred` | **0** | 0 |
| `status_null` | **0** | 0 |
| verdict | **OK** | |

**これが本来 NOTICE で見たかった値である。**
停止点0 で採った事前計数（`delivery_log` 0行・うち `alert_deferred` 0）と一致し、
**移行対象は0件だった**ことが確定した。
実測時点から本番データは動いていない。

`still_alert_deferred = 0` は、`delivery_type = 'alert_deferred'` の行が
`alert` + `status = 'deferred'` へ寄せられた（S-D9）後の残存が無いことを示す。
元が0行なので移行そのものが発生していない。

## Q4. `00024` が足した列・制約

| 項目 | verdict |
| --- | --- |
| `idempotency_key` 列 | **OK** |
| `attempts` 列（NOT NULL / DEFAULT 0） | **OK** |
| `status` が NOT NULL | **OK** |
| `idx_delivery_log_idempotency_key`（UNIQUE） | **OK** |

4件とも実在する。`status` の NOT NULL は、CHECK 制約が NULL を素通りするため
併せて張る必要があったもの（契約 S-D9）。

## 検証SQLそのものについて

`docs/runbooks/2026-08-20_post-deploy-verification.sql` は、**書いた時点では実行検証できていなかった**
（ローカルに DB が無く、Docker 停止・psql 不在）。構文エラーの可能性を明記して渡したが、
**本番で問題なく通った。** Q2 で `unnest(indkey)` を避けて `pg_get_indexdef()` にした判断も、
結果として定義文字列がそのまま読めて有効だった。

## 残る関門

本検証で `00023` / `00024` の適用確認は完了した。デプロイ後に残るのは次の2つ。

| 関門 | 内容 | ブロックする範囲 |
| --- | --- | --- |
| **2-b** | `net._http_response.status_code` が 200（cron の実疎通） | A-2（cron 登録の migration） |
| **S-3-5** | 本番データでの完走（findings 0件が到達点） | **スライスのクローズ** |

S-4-2 後半（本番の実 Function URL へ認証なしで 401）は
**2026-08-20 に合格済み**（`docs/runbooks/2026-08-20_s4-2_401-verification.md`）。
