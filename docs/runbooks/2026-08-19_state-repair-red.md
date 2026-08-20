# 修復前の赤の記録（スライスS / S-5-6 の陰性コントロール）

日付: 2026-08-19
契約: `docs/contracts/slice-state-repair.md` の **S-5-6**
位置づけ: **検出の仕掛けだけを入れ、修復コードは1行も書いていない時点**の実測。

> S-5-6 は「S-5-1 / S-5-2 が**今回の不具合を実際に検出できる**ことを、
> 修復前のコードに対して**赤くなること**で示す」を求めている。
> 直してから検査を足すと「直った気になっている」を検証できないため、
> 検出→赤の確認→修復 の順にしている。

## この時点で入っているもの / 入っていないもの

| 入っている（Step 1）                                | 入っていない（Step 2 以降）              |
| --------------------------------------------------- | ---------------------------------------- |
| `scripts/check-db-error-handling.ts`（S-2-4）       | `_shared/db.ts`（`mustData` / `mustOk`） |
| `scripts/check-caller-guard.ts`（S-4-8 / S-4-9）    | `_shared/caller.ts`（`resolveCaller`）   |
| `scripts/check-schema-contract.ts`（S-5-1）         | 列名の修正・`00023` の一意索引           |
| `scripts/check-allowlist.ts` の実DB照会化（S-5-4）  | `known_explanations` / 予算の修正        |
| `tests/integration/edge-functions.test.ts`（S-5-2） | Edge Function の修正                     |

---

## 実測0: 本番で現に開いている情報漏洩（検収者・2026-08-19）

**これが本スライスで最も重い赤である。** 静的検査の結果より先に置く。

本番の `state-memory-packet` の実 Function URL に対して:

| ケース                     | 修復前       | 応答の中身                             |
| -------------------------- | ------------ | -------------------------------------- |
| `Authorization` ヘッダ無し | **HTTP 200** | `recent_events` の実データ **824文字** |
| 不正な `Bearer <でたらめ>` | **HTTP 200** | 同上                                   |

**関数URLを知っていれば、認証情報を一切持たない第三者が任意の会社の状態を読める。**
`company_id` はボディで受け取ったものをそのまま service_role クライアントに渡しており、
`--no-verify-jwt` でデプロイされているため、ゲートウェイでも止まらない。

この実測を受けて **S-2 の位置づけを「堅牢化」から「現に開いている情報漏洩の閉塞」に変更**し、
実装順序を **S-5 → S-2 → S-1 → S-6 → S-4 → S-3** に変えた（S-2 を S-1 の前に出した）。

合格条件は **同じ2ケースがどちらも 401 になること**（S-4-2）。
ヘッダ無しの1ケースだけでは「JWTを持っているだけでは通らない」を示せないため、2ケースとも実測する。

---

## 実測1: `check:db-errors` — 握りつぶし **58件**

```
$ pnpm run check:db-errors
check:db-errors — 握りつぶし 58件

Supabase の .from() は mustData() / mustOk() で包むこと（契約 S-2-1 / S-2-4）:

  supabase\functions\day0\index.ts:75  .from("events")
  supabase\functions\day0\index.ts:85  .from("events")
  supabase\functions\day0\index.ts:96  .from("connections")
  supabase\functions\day0\index.ts:104  .from("entities")
  supabase\functions\deliver-alert\index.ts:32  .from("delivery_log")
  supabase\functions\deliver-alert\index.ts:89  .from("delivery_log")
  supabase\functions\deliver-alert\index.ts:136  .from("delivery_log")
  supabase\functions\deliver-pulse\index.ts:22  .from("events")
  supabase\functions\deliver-pulse\index.ts:30  .from("findings")
  supabase\functions\deliver-pulse\index.ts:80  .from("delivery_log")
  supabase\functions\deliver-pulse\index.ts:127  .from("delivery_log")
  supabase\functions\deliver-weekly\index.ts:20  .from("findings")
  supabase\functions\deliver-weekly\index.ts:28  .from("baselines")
  supabase\functions\deliver-weekly\index.ts:34  .from("connections")
  supabase\functions\deliver-weekly\index.ts:39  .from("events")
  supabase\functions\deliver-weekly\index.ts:45  .from("events")
  supabase\functions\deliver-weekly\index.ts:134  .from("delivery_log")
  supabase\functions\deliver-weekly\index.ts:181  .from("delivery_log")
  supabase\functions\ingest-calendar\index.ts:55  .from("events")
  supabase\functions\ingest-csv\index.ts:63  .from("events")
  supabase\functions\ingest-monitor\index.ts:55  .from("events")
  supabase\functions\ingest-s0\index.ts:50  .from("events")
  supabase\functions\investigate\index.ts:227  .from("company_summary")
  supabase\functions\investigate\index.ts:237  .from("budget_usage")
  supabase\functions\investigate\index.ts:255  .from("events")
  supabase\functions\investigate\index.ts:316  .from("findings")
  supabase\functions\investigate\index.ts:343  .from("budget_usage")
  supabase\functions\onetap-calendar\index.ts:21  .from("delivery_log")
  supabase\functions\onetap-calendar\index.ts:48  .from("delivery_log")
  supabase\functions\onetap-calendar\index.ts:68  .from("delivery_log")
  supabase\functions\run-sense\index.ts:71  .from("findings")
  supabase\functions\run-sense\index.ts:81  .from("findings")
  supabase\functions\run-sense\index.ts:89  .from("findings")
  supabase\functions\scan\index.ts:27  .from("events")
  supabase\functions\scan\index.ts:35  .from("baselines")
  supabase\functions\scan\index.ts:41  .from("known_explanations")
  supabase\functions\state-baselines\index.ts:28  .from("events")
  supabase\functions\state-baselines\index.ts:56  .from("baselines")
  supabase\functions\state-memory-packet\index.ts:23  .from("company_summary")
  supabase\functions\state-memory-packet\index.ts:24  .from("baselines")
  supabase\functions\state-memory-packet\index.ts:29  .from("events")
  supabase\functions\state-memory-packet\index.ts:35  .from("findings")
  supabase\functions\state-memory-packet\index.ts:40  .from("narratives")
  supabase\functions\state-narratives\index.ts:28  .from("narratives")
  supabase\functions\state-narratives\index.ts:37  .from("narratives")
  supabase\functions\state-narratives\index.ts:57  .from("narratives")
  supabase\functions\state-narratives\index.ts:76  .from("narratives")
  supabase\functions\state-summary\index.ts:25  .from("events")
  supabase\functions\state-summary\index.ts:31  .from("baselines")
  supabase\functions\state-summary\index.ts:32  .from("narratives")
  supabase\functions\state-summary\index.ts:33  .from("entities")
  supabase\functions\state-summary\index.ts:105  .from("company_summary")
  supabase\functions\sync-connections\index.ts:44  .from("connections")
  supabase\functions\sync-connections\index.ts:136  .from("connections")
  supabase\functions\sync-connections\index.ts:231  .from("events")
  supabase\functions\sync-connections\index.ts:319  .from("events")
  supabase\functions\_shared\token-refresh.ts:150  .from("connections")
  supabase\functions\_shared\token-refresh.ts:173  .from("connections")
EXIT=1
```

**読み取れること**: 握りつぶしは State層に限った話ではなく、**DBに触る全経路に一様に空いている**。
`_shared/token-refresh.ts` にも2件ある。S-2 の適用範囲を17本すべてにした判断
（S-2-0）はこの分布と一致する。

## 実測2: `check:caller-guard` — 封鎖漏れ **17本 / デプロイ対象 17本**

```
$ pnpm run check:caller-guard
check:caller-guard — 封鎖漏れ 17本 / デプロイ対象 17本

  sync-connections: resolveCaller() を呼んでいない（契約 S-4-8）
  scan: resolveCaller() を呼んでいない（契約 S-4-8）
  investigate: resolveCaller() を呼んでいない（契約 S-4-8）
  run-sense: resolveCaller() を呼んでいない（契約 S-4-8）
  ingest-calendar: resolveCaller() を呼んでいない（契約 S-4-8）
  ingest-csv: resolveCaller() を呼んでいない（契約 S-4-8）
  ingest-s0: resolveCaller() を呼んでいない（契約 S-4-8）
  ingest-monitor: resolveCaller() を呼んでいない（契約 S-4-8）
  state-baselines: resolveCaller() を呼んでいない（契約 S-4-8）
  state-summary: resolveCaller() を呼んでいない（契約 S-4-8）
  state-narratives: resolveCaller() を呼んでいない（契約 S-4-8）
  state-memory-packet: resolveCaller() を呼んでいない（契約 S-4-8）
  deliver-alert: resolveCaller() を呼んでいない（契約 S-4-8）
  deliver-pulse: resolveCaller() を呼んでいない（契約 S-4-8）
  deliver-weekly: resolveCaller() を呼んでいない（契約 S-4-8）
  day0: resolveCaller() を呼んでいない（契約 S-4-8）
  onetap-calendar: resolveCaller() を呼んでいない（契約 S-4-8）
EXIT=1
```

**分母が deploy.yml の実デプロイ対象**であることが要点（S-4-8）。
`supabase/functions/` のディレクトリ一覧を分母にすると、
「deploy.yml にだけ足された関数」を見逃す。

## 実測3: `check:allowlist` — 空洞が塞がったことの確認（S-5-4）

修正前は `console.log` 1行で **必ず exit 0** だった。実DB照会に変えた結果:

```
$ pnpm run check:allowlist
check:allowlist — 実DBを照会できなかった: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定のため実DBを照会できない
照会できないことを「違反なし」に丸めない（fail-closed）。
[ELIFECYCLE] Command failed with exit code 1.
EXIT=1
```

「照会できない」を「違反なし」に丸めない（fail-closed）。
`.github/workflows/ci.yml` では **verify ジョブから integration ジョブへ移した**。
Supabase が起きているのは integration ジョブだけであるため。

## 実測4: `check:schema` の静的抽出（S-5-1 の前半）

実DBとの突合は CI の integration ジョブで走る。静的抽出だけの結果:

```
accesses: 259
--- select("*") ---
  supabase\functions\deliver-weekly\index.ts:41  events
  supabase\functions\deliver-weekly\index.ts:47  events
  supabase\functions\scan\index.ts:37  baselines
  supabase\functions\state-narratives\index.ts:30  narratives
  supabase\functions\state-summary\index.ts:31  baselines
  supabase\functions\state-summary\index.ts:32  narratives
  supabase\functions\state-summary\index.ts:33  entities
--- 静的に読めない書き込み ---
  supabase\functions\ingest-calendar\index.ts:55  events
  supabase\functions\ingest-csv\index.ts:63  events
  supabase\functions\ingest-monitor\index.ts:55  events
  supabase\functions\ingest-s0\index.ts:50  events
  supabase\functions\sync-connections\index.ts:231  events
  supabase\functions\sync-connections\index.ts:319  events
```

**`scan/index.ts:37` の `select("*")` が、P-3 の不具合が隠れていた場所そのもの。**
`select("*")` で baselines を引き、`bl.p25` / `bl.iqr` を直接読んでいるため、
列が存在しなくても `undefined` になり、比較が NaN になって**静かに0件**になる。
`select("*")` を違反にしているのは、これを二度と隠せなくするため。

静的に読めない書き込み6件（すべて `events` への `insert(rows)`）は、
**黙って飛ばさず一覧に出す**。突合の担当は実DBテスト（S-5-2）に移る。

## 実測5: 検査自体の陽性・陰性コントロール（S-4-9 / S-2-4）

検査が空洞になっていないことを、検査対象のフィクスチャで固定してある。

```
$ pnpm exec vitest run tests/unit/check-db-error-handling.test.ts tests/unit/check-caller-guard.test.ts tests/unit/check-schema-contract.test.ts
 Test Files  3 passed (3)
      Tests  28 passed (28)
```

- `tests/fixtures/db-access/good.ts.fixture` — 正しい書き方が **violation 0件**
- `tests/fixtures/db-access/bad.ts.fixture` — 握りつぶし3件を**すべて検出**
- `check-caller-guard.test.ts` — 封鎖済み2本＋未封鎖1本で、未封鎖だけを検出

## ユニットテスト全体（この時点）

```
$ pnpm exec vitest run --exclude 'tests/e2e/**' --exclude 'tests/integration/**'
 Test Files  34 passed (34)
      Tests  226 passed (226)
```

`pnpm typecheck` / `pnpm lint` も通る（出力なし＝エラーなし）。

## ローカルで実測できなかったこと

**Docker Desktop が停止しており `supabase start` が実行できない。**

```
$ docker info --format '{{.ServerVersion}}'
failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine;
check if the path is correct and if the daemon is running
```

したがって以下は **CI の integration ジョブで実測する**（このコミットを push して確認する）:

- `check:schema` の実DB突合（S-5-1 の後半）
- `tests/integration/edge-functions.test.ts` の赤（S-5-2 / S-1-5 / P-4）
- **`supabase start` が Edge Runtime を配信するか**（ci.yml に到達性の probe ステップを置いた。
  「動いているはず」で進めず、実HTTPのステータスをログに出させる）

## 次の停止点

この赤の確認をもって Step 2（S-1 / S-2 の修復）に進む。
修復後、同じ4つの検査が**緑になること**を同じ形で記録する。

---

## 追記（2026-08-20）— 「握りつぶし 18件」は真値ではなかった

上の実測で記録した **18件は、検査器自身の盲点によって過少に出ていた数**である。
S-2 の修復に入る前にこれが判明したので、経緯を残す。

### 何が起きていたか

`scripts/check-db-error-handling.ts` の `blankOutNonCode()` は、コメントと文字列リテラルを
同じ長さの空白に潰してから `.from(` を探す。ここに**正規表現リテラルの扱いが無かった**。

`supabase/functions/day0/index.ts:142` の

```
const mc = html.match(/<meta[^>]+charset=["']?([^"'\s;>]+)/i);
```

の `["']` を「`"` で始まる文字列」と読み、次の `"` まで飛び、続く `'` を今度は
「`'` で始まる文字列」の開始と読んだ結果、**142行目から158行目まで**が1つの文字列として
扱われ、そこから同期が壊れた。以降 `day0` のほぼ全域が「文字列の中身」として空白化され、
検査器からは**コードが1文字も見えていなかった**。

### 数字

|            | 検査器の状態           | 握りつぶし | day0 の可視性                         |
| ---------- | ---------------------- | ---------- | ------------------------------------- |
| 修復前     | 正規表現リテラル未対応 | **18件**   | raw 6箇所すべて不可視（violations 0） |
| 修復後     | 正規表現リテラル対応   | **20件**   | raw 6箇所のうち 2件を検出             |
| S-2 完了時 | 同上                   | **0件**    | —                                     |

増えた2件は `day0/index.ts:953` / `:1009`。**どちらも送信部の `delivery_log` 書き込み**で、
まさに S-2-6 〜 S-2-8 で作り替える箇所だった。

可視範囲の突き合わせ（修復後の実測）:

```
TOTAL raw=61 violations=20 guarded=41
```

`raw 出現数 = 検出数 + 通過数` が成立している。数が合わなければ、どこかが見えていない。

### 学び

`'\t'` の取り違え（S-5・`scripts/live-schema.ts`）と**同型**である。
どちらも「検査が通らない」ではなく「**検査が静かに見えなくなる**」形で出た。

- ソースを字句として読む検査器は、コメント・文字列に加えて**正規表現リテラルを必ず扱う**
- 判定を誤る向きも設計する。**除算を正規表現と読むと後続コードを飲み込んで見えなくなる**ので、
  迷ったら除算に倒す（識別子・数値・`)`・`]`・閉じ引用符の直後は除算とみなす）
- 検査器を直したら**可視範囲を数で突き合わせる**。「検出0件」は「違反0件」を意味しない

固定はユニットテスト4件（`tests/unit/check-db-error-handling.test.ts` の
「正規表現リテラル」ブロック）。検査器を緩めた瞬間に赤くなる。

## 追記（2026-08-20）— Edge Function の型検査はどのジョブが担保しているか

`tsconfig.json` は `supabase/functions/*/index.ts` を除外しているため、
**`pnpm typecheck`（tsc）は Edge Function の `index.ts` を見ていない。**
`_shared/*.ts` は `@edge/*` エイリアス経由で tsc の対象に入る。

型検査の実体は CI の **`edge-functions` ジョブ**（`.github/workflows/ci.yml`）である。

- `denoland/setup-deno@v2`（`v2.1.4` 固定）
- `Verify check target covers every function and _shared file` —
  `FUNC_DIRS == INDEXES` と `TOTAL == INDEXES + SHARED` をアサートし、
  **検査対象から静かに漏れる経路を塞ぐ**
- `deno check --no-lock --node-modules-dir=none` を
  `supabase/functions` 配下の全 `.ts` に対して実行

2026-08-20 時点のローカル実測（同じ算術を手で再現）:

```
FUNC_DIRS=17 INDEXES=17 SHARED=13 TOTAL=30
check1 OK
check2 OK
```

`_shared/delivery.ts` / `delivery-response.ts` / `mailer.ts` の3本もこの `SHARED=13` に
含まれている。**「CIで検証される」と書く前に、そのジョブが実在することを毎回確かめること**
（`check:allowlist` が1行 log で緑を返していたのと同じ穴を作らない）。
