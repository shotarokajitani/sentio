# 環境差分チェックリストの点検 — スライスD / migration 00027（受入基準 D-4-2）

対象: `supabase/migrations/00027_connections_revoked_at.sql`
（`connections.revoked_at TIMESTAMPTZ` の追加。本スライス唯一の新規 migration）

点検日: 2026-08-27 / 実施: ローカル Claude Code
正本: `docs/checklists/env-diff.md`

**この環境に Docker は無い。** 実DBに当たる確認（`supabase db reset` / `check:allowlist` /
`check:schema`）は `ci.integration` に委ねる。ここに書くのは**ローカルで実測できた事実**と、
**CI に委ねた項目の明示**である。実測していないものを点検済みと書かない。

---

## 項目別の点検結果

| #   | 項目                   | 判定           | 根拠                                                                 |
| --- | ---------------------- | -------------- | -------------------------------------------------------------------- |
| 1   | Exposed schemas        | 該当なし       | 新スキーマを作っていない。`public.connections` への列追加のみ        |
| 2   | PostgreSQL メジャー版  | **版依存なし** | 下記の実測を参照                                                     |
| 3   | Edge Runtime の policy | 影響なし       | `per_worker` のまま。下記の実測を参照                                |
| 4   | Extensions             | 該当なし       | 新規拡張を要求しない。Vault は既存（00012 / 00025）                  |
| 5   | env / Secrets          | 該当なし       | 新規の環境変数・Secret を増やしていない（`.env.example` に差分なし） |
| 6   | DNS / ドメイン認証     | 該当なし       | メール送信経路に触れていない                                         |
| 7   | RLS                    | 追加不要       | 下記の実測を参照                                                     |
| 8   | redirect URI           | 該当なし       | OAuth の redirect URI を変えていない                                 |

---

## 2. PostgreSQL のメジャーバージョン

本番の実測値は **PostgreSQL 17.6**（2026-08-20 / 梶谷さんが本番の SQL Editor で
`select version();` を実行。`docs/checklists/env-diff.md` に記録済み）。

`supabase/config.toml` の宣言は **15** である（実測: `supabase/config.toml:24`）。

```
$ grep -n "major_version" supabase/config.toml
24:major_version = 15
```

**この差は 00027 には影響しない。** 00027 が使う構文は2つだけで、どちらも
PostgreSQL 15 でも 17 でも同じ意味を持つ。

| 構文                                       | 導入版   | 判定     |
| ------------------------------------------ | -------- | -------- |
| `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` | 9.6      | 両版で可 |
| `COMMENT ON COLUMN`                        | 以前から | 両版で可 |

`00023` のような版依存の構文（`NULLS NOT DISTINCT`・15 以降）は使っていない。
したがって 00027 に版ガードは要らない。

> **宣言と実測のずれ自体は残っている。** これは 00027 が持ち込んだ差分ではなく、
> `config.toml` が宣言であって実測ではないという既知の状態である
> （`docs/checklists/env-diff.md` の同項目が同じことを書いている）。
> ここで勝手に `major_version` を書き換えない。ローカル・CI の起動版を変える行為であり、
> 本スライスの範囲外である。**未判断として残す。**

## 3. Edge Runtime の policy

`supabase/config.toml:196` が `policy = "per_worker"`（実測）。本スライスで変えていない。

`per_worker` はワーカーをリクエスト間で使い回すので、**Function のモジュールスコープの
状態が残る**。今回変更した `supabase/functions/_shared/token-refresh.ts` に
モジュールスコープの可変状態が無いことを実測した。

```
$ grep -nE "^(let|var) " supabase/functions/_shared/token-refresh.ts
（0件）
```

追加した `classifyTokenFailure` は引数だけから戻り値が決まる純粋関数で、
`markRevoked` は引数で渡された `supabase` クライアントしか触らない。
リクエストをまたいで持ち越す状態を持たないので、`per_worker` の影響を受けない。

## 7. RLS

`connections` は 00007 で RLS 有効化済みで、ポリシーは
`users_own_connections`（`FOR ALL` / `USING (company_id = auth.uid())`）。

**列の追加はポリシーの対象範囲を変えない。** `FOR ALL` は行に対する規則であり、
列を増やしても新しい抜け道は生まれない。したがって 00027 に追加のポリシーは要らない。

`revoked_at` を書く経路は `token-refresh.ts`（Edge Function / service_role）だけである。
service_role は RLS を迂回するが、これは既存の `status` / `last_refresh` の書き込みと
同じ経路であり、本スライスが新しく開けた口ではない。

読む経路は現状無い（30日削除＝契約 D-3 は本スライスで実装しない。契約の停止点）。
`fetchConnectionOverview` の `select` にも `revoked_at` を足していないので、
画面へは出ない（U-3 の確定「通知しない・画面は既存の要再連携のまま」と整合する）。

## allowlist（絶対規則の確認）

`check:allowlist` の対象は `events` のみ（`scripts/check-allowlist.ts` の `EVENTS_ALLOWLIST`）。
`connections` への列追加は絶対規則「S2テーブルに本文型カラムを追加しない」に抵触しない。
そもそも `TIMESTAMPTZ` であって本文型でもない。

---

## CI に委ねた項目（**ローカルでは実行できない**）

| 検査                                         | 何を確かめるか                                     | ジョブ           |
| -------------------------------------------- | -------------------------------------------------- | ---------------- |
| `supabase db reset`                          | 00001〜00027 の全件が素通しで適用できる            | `ci.integration` |
| `check:allowlist`                            | S2 allowlist と実DBの列の突合                      | `ci.integration` |
| `check:schema`                               | Edge Function の参照列と実DBの突合（`revoked_at`） | `ci.integration` |
| `tests/integration/token-revocation.test.ts` | `revoked_at` が実DBに書けること                    | `ci.integration` |

**判定は CI の色で行う。** ローカルが全緑でも完了ではない。
