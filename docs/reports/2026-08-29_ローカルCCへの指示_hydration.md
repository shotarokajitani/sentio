# ローカル Claude Code への指示 — `/connect` の hydration mismatch（2026-08-29）

【指示文】の中身をそのまま `C:\Users\shota\sentio` で起動した Claude Code に貼る。

---

## 【指示文】ここから

`/connect` が本番で出している React error #418（hydration mismatch）を直す。
作業ディレクトリは `C:\Users\shota\sentio`。

まず `CLAUDE.md` と `.claude/rules/nextjs.md` を読むこと。

### 何が起きているか（本番で実測済み・2026-08-27 / 08-28）

`https://sentio-ai.jp/connect` を開くとコンソールに次が出る。

```
Error: Minified React error #418; visit https://react.dev/errors/418?args[]=text&args[]=
```

原因は `src/app/connect/connect-client.tsx:117-125` の `formatDate`。

```ts
const formatDate = (iso: string | null) => {
  if (!iso) return t.connect.never;
  return new Date(iso).toLocaleString("ja-JP", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};
```

**`timeZone` を指定していない。** サーバ（Vercel＝UTC）は `8月22日 17:18` を描き、
クライアント（JST）は `8月23日 02:18` を描く。差はちょうど9時間で、これが不一致になる。

**同じ形を `/report` では作らなかった。** `src/app/report/report-view.tsx` は
`Intl.DateTimeFormat` に `timeZone: "Asia/Tokyo"` を明示しており、
**本番で #418 が出ないことを実測している**（`onlyErrors` で0件。`/connect` は同条件で出る）。
`/report` の書き方が正解なので、それに合わせる。

### やること

`connect-client.tsx` の日時表示を `timeZone: "Asia/Tokyo"` 明示に直す。
**`report-view.tsx` と同じ形にすること**（モジュールスコープの `Intl.DateTimeFormat` を
使い回す形が既にあるので、書き方を揃える）。

### 受入基準

| #   | 基準                                                                                        | 検証                                                       |
| --- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| H-1 | `formatDate` の出力が **`TZ=UTC` と `TZ=Asia/Tokyo` で完全に一致する**                      | unit（**陰性コントロール。これが壊れていた性質そのもの**） |
| H-2 | 既知の ISO 文字列（例 `2026-08-22T17:18:00Z`）が **JST の `8月23日 02:18`** として描かれる  | unit                                                       |
| H-3 | `last_refresh` が `null` の行は既存どおり `t.connect.never` を出す。**例外にしない**        | unit                                                       |
| H-4 | `/connect` のレンダ結果に**出席者やトークンなどの秘密が混ざらない**（既存の性質を壊さない） | unit                                                       |

**H-1 を先に書くこと。** `TZ` を変えて2回描画し、文字列が同一であることを直接見る。
`timeZone` を消せば落ちるテストになっていること（陰性コントロール）を、
一度わざと消して確認し、実物の出力を報告に貼ること。

### 触ってはいけないもの

- `report-view.tsx` は直さない（既に正しい）
- migration を作らない。スキーマを触らない
- `/connect` の解除 UI（slice-D）の挙動を変えない
- 本番 Ref `kwpldqbnkraftaahnpev` への CLI 直接操作をしない

### 併せてやる（docs のみ・同じ PR でよい）

`docs/runbooks/2026-08-20_google-oauth-verification.md` の
**【1】「実装が伴っていないもの」・【5】「実装が要るもの」・【6】順序** が古い。
スコープ差し替え・連携解除時の削除・デモ動画・テストアカウント・再提出は
**すべて完了している**のに、未着手のように読める。
完了済みの項目に実施日と参照先（PR番号・契約ファイル）を付けて消し込むこと。
**まだ終わっていないものは終わったと書かない**（24ヶ月削除の定期処理と
アカウント削除の運用手順書は要確認。実物を見てから判断すること）。

### 検査（Docker 無しで回せるものだけ）

```
pnpm typecheck
pnpm lint
pnpm exec vitest run --exclude 'tests/e2e/**' --exclude 'tests/integration/**'
pnpm run check:db-errors
pnpm run check:caller-guard
pnpm run check:ci-coverage
pnpm run check:edge-types
pnpm run eval:engine
```

### push 後

`origin/main` から新しいブランチを切る。CI 全ジョブと Vercel チェックの完了まで
自律監視する。全緑になったら**全ジョブの結果＋実行実態証跡**を添えて報告する。
**merge はしない。**

`jq` をローカルの監視ループで使わないこと（`.claude/skills/gotchas` の既知の形）。

### 完了報告に必ず含めること

- H-1 の陰性コントロールの実物出力（`timeZone` を消したときに落ちること）
- 直した後の `formatDate` 相当のコード
- 消し込んだ runbook の項目と、まだ終わっていないと判断した項目とその根拠

## 【指示文】ここまで

---

## 検収結果（2026-08-29・本番で実測）

**合格。#418 は消えた。**

PR #47（`bc02f3f`）merge → deploy 後の本番 `https://www.sentio-ai.jp/connect` を、
**ログイン済みのセッションで開いて確認した。**

| 確認 | 修正前（2026-08-27/28） | 修正後（2026-08-29） |
| --- | --- | --- |
| `read_console_messages(onlyErrors)` | **React error #418 が1件** | **0件** |
| 「最終同期」の表示 | サーバ `8月22日 17:18`（UTC）→ クライアント `8月23日 02:18`（JST）に飛ぶ | **`8月29日 21:00` で安定**（JST） |

`21:00 JST` は cron の `0 0,6,12,18 * * *` UTC のうち **12:00 UTC** の発火に対応する。
UTC のまま描かれていれば `12:00` と出るはずで、出ていない。

**「飛ばない」ことの証明は #418 が消えたこと自体である。**
サーバとクライアントで文字列が違えば React が hydration を諦めて #418 を出す。
出ていない＝両者が同じ文字列を描いている。

これで `/connect` と `/report` の両方がコンソールエラー0件になった。

### CC が詰められなかった一歩について

CC は「`/connect` の描画は認証必須で、ログイン資格情報を持たないため未確認」と報告した。
**その判断は正しい。** パスワードを扱わない前提を崩さずに止まっている。
検収側（Cowork）はブラウザに既存のログイン済みセッションがあるので、そこだけを引き取った。
**分担としてはこれが正しい形である。**
