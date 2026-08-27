# `SUPABASE_SERVICE_ROLE_KEY` は**新形式 `sb_secret_...` だった**（2026-08-27 実測）

**`invoke-function` が一度も 2xx を返せなかった原因が確定した。**
Supabase が Edge Function に注入している `SUPABASE_SERVICE_ROLE_KEY` は
**レガシー JWT（`eyJ...`）ではなく、新形式の Secret key（`sb_secret_...`）である。**

これは `docs/spec/07_open_items.md`「レガシー JWT キーの廃止と、ゲートウェイ JWT 検証の依存」の
**前提を覆す。同項の書き直しが要る。**

---

## 決定的な実測

GitHub Secrets の `SUPABASE_SERVICE_ROLE_KEY` に入れる値だけを変え、他は一切変えていない。

| run                 | 入れた値                                                                           | 結果                                      |
| ------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------- |
| `33034081943`（#4） | レガシー JWT（`eyJ...`・219文字・`role=service_role`・`ref=kwpldqbnkraftaahnpev`） | **HTTP 401** / `{"error":"unauthorized"}` |
| `33034921731`（#5） | 同上（ダッシュボードから採り直して上書き）                                         | **HTTP 401**（同じ）                      |
| `33044220108`（#6） | **新形式 Secret key（`sb_secret_...`）**                                           | **HTTP 200** ✅                           |

`#6` の実出力:

```
HTTP status: 200
本文バイト長: 164
本文 SHA-256: 599250980b4b20c6751f85a8f03d971e46af3dc963457facf7cc0dc6c3781d0d
（2xx の本文は顧客データを含みうるため出力しない）
--- 件数スカラー（allowlist 抽出。本文は出力しない） ---
total_candidates: 0
immediate_count: 0
investigation_count: 0
--- ここまで（allowlist 外のキーは除外 4 件・名称も非出力） ---
```

**PR #42 の件数スカラー抽出が、初めて本番の実データに対して働いた。**
本文は1バイトも出ず、`total_candidates: 0` だけが出ている。設計どおり。

## なぜ 401 だったのか

`supabase/functions/_shared/caller.ts:117`:

```ts
if (secretEquals(token, readEnv("SUPABASE_SERVICE_ROLE_KEY"))) { ... internal }
```

`resolveCaller` は**文字列の完全一致**で internal を判定する。
送ったレガシー JWT は、関数の env（`sb_secret_...`）と一致しない。したがって 401。

**ゲートウェイは通っていた。** レガシー JWT secret は「検証にのみ使われる」状態で
まだ有効だからである（Supabase ダッシュボード JWT Keys → Legacy JWT Secret の文言:
"It is used to **only verify** JSON Web Tokens by Supabase products"）。
だから 401 の本文が Supabase のものではなく Sentio 自身のもの
（`{"error":"unauthorized"}`・24バイト）になっていた。**この切り分けが決め手だった。**

## 併せて判明した本番の状態（ダッシュボード実測）

| 項目                   | 実測                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------ |
| JWT 署名鍵（CURRENT）  | **ECC (P-256)**。非対称鍵へ移行済み                                                  |
| JWT 署名鍵（PREVIOUS） | Legacy HS256 (Shared Secret) / **5ヶ月前にローテート済み**                           |
| Legacy JWT secret      | **検証専用**。変更は standby key の作成 → revoke でしか行えない                      |
| API Keys のタブ構成    | 「Publishable and secret API keys」と「Legacy anon, service_role API keys」の2本立て |

## 07_open_items の書き直しが要る（**未着手**）

現行の記述は次の前提に立っている。

> Edge Functions は `anon` / `service_role` の **JWT ベースのキーでしか** JWT 検証が動かない。
> publishable / secret キーを使うなら `--no-verify-jwt` が要る。

**この前提と、いま実測した「関数の env は `sb_secret_...`」は整合しない。**
17本すべてから `--no-verify-jwt` を外した設計（S-4・案B）が、
実際には何によって守られているのかを取り直す必要がある。

**未判断のまま残す。** 次にやること:

1. 本番の Function URL へ**認証なし**で叩いて 401 になるか（S-4-2 の再実測）
2. **レガシー anon JWT** で叩いて 401 になるか（「JWT を持っているだけでは通らない」の再実測）
3. その結果を見て、`07_open_items` の当該項目を書き直す

## ローテーションは中止した（2026-08-27・検収者判断）

`docs/runbooks/2026-08-20_service-role-rotation.md` の実施を、手順3の直前で中止した。

- レガシー JWT secret は**検証専用**で、変更には standby key の作成と revoke が要る（大掛かり）
- そもそも**原因がこれではなかった**
- 実施していれば、全ユーザー強制ログアウトと本番停止を招いたうえで**何も直らなかった**

事前計数（手順1）の結果は記録しておく。

```
users = 2 / active_sessions = 8 / live_connections = 1
```

旧 service_role（レガシー JWT）の指紋:
`len=219 / prefix=eyJ / tail=KZbIpk / sha256=1e5c6308a7b0`（先頭12文字のみ）

## 残る宿題

- [ ] `docs/secrets-runbook.md` の「保管先3箇所」の記述を、**新形式が正である**前提に直す
- [ ] Vault `sentio_service_role_key`（cron の Bearer）が**どちらの形式か**を確認する。
      レガシーのままなら cron は静かに 401 している可能性がある（停止点2-b）
- [ ] Vercel env の `SUPABASE_SERVICE_ROLE_KEY` がどちらの形式かを確認する
- [ ] `07_open_items` のレガシー JWT 項目の書き直し

---

## S-4-2 の再実測 — **ゲートウェイ層は守っていなかった**（2026-08-27・検収者が本番で実測）

上の「次にやること」1 を実施した結果。

```
GET https://kwpldqbnkraftaahnpev.supabase.co/functions/v1/state-memory-packet
（Authorization ヘッダ無し）
→ {"error":"unauthorized"}
```

**この本文は Sentio 自身のものである。** `supabase/functions/_shared/caller.ts:63-64` の
`unauthorized()` が返す `jsonResponse(401, { error: "unauthorized" })` と一致する。
Supabase ゲートウェイが自前で返す 401 の本文ではない。

つまり **リクエストはユーザーワーカーまで届いている。ゲートウェイの JWT 検証を素通りしている。**

### 何が崩れるか

`state-memory-packet` は `--no-verify-jwt` を**付けずに**デプロイされている
（`.github/workflows/deploy.yml:152`）。同ファイル `:99-102` は、その意図をこう書いている。

> `--no-verify-jwt` は付けない（契約 S-4 / 封鎖は S-方針2 の案B＋A の二層）。
> `state-memory-packet` が HTTP 200 と実データを返したのは、この17本すべてに
> `--no-verify-jwt` が付いていてゲートウェイが素通しだったためである。

**この前提が実測と合わない。** フラグを外したのに、認証なしのリクエストがワーカーまで届いている。
したがって

- 17本から `--no-verify-jwt` を外した＝ゲートウェイ層で守る、という S-4 の設計は
  **実際には成立していない**
- 現に守っているのは `resolveCaller` **だけ**である
- **漏洩はしていない**（`resolveCaller` が fail-closed で 401 を返している）。
  だが二層の防御ではなく**一層**である。片方が壊れたときの余地が無い

上の「JWT 署名鍵は ECC (P-256) へ移行済み / 関数の env は `sb_secret_...`」という実測と
併せて読むと、ゲートウェイの検証が何に対して働いているのか自体を取り直す必要がある。

### 追実測 — **ゲートウェイは JWT を検証していない**（2026-08-27・同日）

鍵を持たずに確かめられる形で追試した。本番の同一オリジンから `fetch` を3通り投げ、
`Authorization` ヘッダだけを変えている（POST・本文は存在しない `company_id`）。

| ケース | 送った `Authorization` | status | 本文 |
| --- | --- | --- | --- |
| no-auth | （ヘッダ無し） | 401 | `{"error":"unauthorized"}` |
| garbage-bearer | `Bearer not-a-jwt-at-all` | 401 | `{"error":"unauthorized"}` |
| malformed-jwt | `Bearer eyJ...badsignature`（署名が不正な JWT） | 401 | `{"error":"unauthorized"}` |

**3件とも本文が同一で、いずれも `caller.ts` の `unauthorized()` の出力である。**

ゲートウェイが JWT を検証しているなら、`garbage-bearer` と `malformed-jwt` は
**Supabase 自身のエラー本文**（`{"code":401,...}` の形）で弾かれるはずで、
ワーカーまで届かない。届いている以上、**ゲートウェイは JWT を検証していない。**

`--no-verify-jwt` を外したことは、**実効的に何も足していない。**
これで「レガシー anon JWT で叩く」実測を待つ必要はなくなった。
鍵の種類の問題ではなく、**検証そのものが行われていない。**

### 進捗

- [x] 1. 本番の Function URL へ**認証なし**で叩いて 401 になるか（S-4-2 の再実測）
      → 401 になるが、**返しているのは `resolveCaller` であってゲートウェイではない**
- [x] 2. ~~レガシー anon JWT で叩いて 401 になるか~~
      → **不要になった。** 不正な JWT でもワーカーまで届くことを上の追実測で確認した。
      鍵の種類以前に、ゲートウェイが検証していない
- [ ] 3. その結果を見て `07_open_items` の当該項目を書き直す

**未判断のまま残す。** ここで `--no-verify-jwt` の付け外しやデプロイ設定を動かさない。

**書き直しの土台になる事実は揃った。**

1. 関数の env の `SUPABASE_SERVICE_ROLE_KEY` は新形式 `sb_secret_...`
2. JWT 署名鍵は ECC (P-256) へ移行済み。レガシー HS256 は検証専用の「過去の鍵」
3. **ゲートウェイは JWT を検証していない**（不正な JWT がワーカーまで届く）
4. したがって S-4 の「案B＋A の二層」は**一層**。守っているのは `resolveCaller` だけ
5. **漏洩はしていない。** `resolveCaller` が fail-closed で 401 を返している

**残るのは「一層でよいと判断するか、二層に戻すか」という設計判断であり、これは人間の判断待ちである。**
