# スライスA契約書 — 認証・UI・受け入れ準備

状態: active（2026-08-18 検収者承認）/ 環境: Supabaseブランチ＋Vercel preview ＋ 本番実測 /
採点者: sprint-evaluator ＋ 検収者関門

## 目的

「実ユーザーを1社でも受け入れられる状態」に到達する。
現状の `/register` → `/connect` 一本は**company_id をハードコードした単一デモ会社**の上で動いており、
`/api/connections` は認証を持たない。実データが1件でも入った瞬間に
「company_id を知っていれば誰でも読める」経路になる（`docs/spec/07_open_items.md` §1）。
このスライスは、その穴を塞ぎ、外に見せられる画面に整え、Google審査の前提物を揃えるところまでを1本にする。

## スコープ / 非スコープ

IN: Supabase Auth によるサインアップ/ログイン / company_id の auth.uid() 由来化 /
クライアント供給の company_id を信用している全APIの認証保護と越境不可の固定 /
`/register`・`/connect`・`/register/complete` のデザイン刷新 /
再連携動線（`reauth_required` → 再接続 → `active`）/ プライバシーポリシー・利用規約ページ

OUT: 組織・メンバー招待（1認証ユーザー＝1社の前提を崩さない）/ パスワードリセット以外のアカウント管理 /
プライバシーポリシー・利用規約の**法的確認**（人間の関門）/ Google OAuth 審査の**申請行為**（人間の合図＝関門2）/
Findingや配信まわりの機能追加

## 前提として確定している制約（実測済み・変更するなら本契約の外）

- `supabase/migrations/00019_rls_with_check.sql` の全ポリシーが `company_id = auth.uid()` を条件式に持つ。
  したがって**認証ユーザーIDがそのまま company_id** であり、1認証ユーザー＝1社になる。
  A-1 はこの前提の上に載せる（別モデルにするならRLS全面改訂＝別スライス）
- `companies` テーブルは存在しない。company_id は各テーブルのUUIDカラムでありFKを持たない
- 再連携が必要な状態を表す status 値の実装は `reauth_required`
  （`supabase/functions/_shared/token-refresh.ts`）。slice-02 の `needs_reauth` は例示であり正本ではない
- `@supabase/ssr` は package.json に導入済み・未使用。新規ライブラリ追加は発生しない見込み

## 受け入れ基準（全passが必要）

### A-1 認証導入

認証方式は **Email＋パスワード**（2026-08-18 承認）。
既存の `tests/integration/rls.test.ts` が同方式で2テナントを作る検証ハーネスを持っており、
A-2-3 をその延長で書ける。またメール送達設定（Custom SMTP）やGoogle審査という
人間関門に**先行依存しない**。将来 Google SSO を追加しても `auth.uid()` は不変なので company_id も不変。

- A-1-1 Supabase Auth によるサインアップ／ログインが**本番で**機能する（実測証跡を添付）
- A-1-2 `/register`・`/connect` からハードコードされた company_id
  `00000000-0000-0000-0000-000000000001` が消え、company_id が `auth.uid()` 由来になる
- A-1-3 未ログインで `/connect` に到達した場合、ログイン導線に落ちる（白画面・エラーコード露出をしない）
- A-1-4 既存の検証用接続1件（`connections.id = 135619bb-ff0b-44a2-885f-65337aa3f4f3`）は
  **作り直す**（2026-08-18 承認）。新アカウントで Google を接続し直し、
  旧行（`connections` 1行＋対応する `events`）の削除は**人間が本番 SQL Editor で実行**する。
  実装側は削除SQLを検収者確認用に提示するところまでを担い、本番への直接操作は行わない

### A-2 API保護（`docs/spec/07_open_items.md` §1 のクローズ）

対象は `/api/connections` だけではない。**クライアント供給の company_id を無検証で信用している
5本すべて**を、セッション由来に統一する。

| ルート                                     | 現状の受け取り方                              | 影響                                                              |
| ------------------------------------------ | --------------------------------------------- | ----------------------------------------------------------------- |
| `src/app/api/connections/route.ts`         | クエリparam                                   | 読み取り越境（07_open_items §1）                                  |
| `src/app/api/csv/ingest/route.ts`          | JSON body                                     | 他社に events を書き込める                                        |
| `src/app/api/competitors/suggest/route.ts` | JSON body                                     | 他社に events を書き込める                                        |
| `src/app/api/auth/google/route.ts`         | クエリparam を OAuth `state` にそのまま入れる | 他社に接続を紐付けられる／stateがCSRFトークンとして機能していない |
| `src/app/api/auth/freee/route.ts`          | 同上                                          | 同上                                                              |

- A-2-1 対象APIが未認証リクエストに 401（または403）を返す
- A-2-2 company_id をクエリパラメータ／リクエストボディで受け取らない。セッションから導出する
- A-2-3 認証済みユーザーは自社分のみ取得・書き込みできる。**他社 company_id を明示的に指定しても
  他社データが読めず・書けない**ことを、2ユーザー2社を実際に作る実クエリテストで固定する（テストコードとして残す）
- A-2-4 OAuth `state` が乱数CSRFトークンになり、コールバックで照合される
- A-2-5 `docs/spec/07_open_items.md` §1 をクローズ済みに更新する

### A-3 UI刷新（`/register`・`/connect`・`/register/complete`）

運用ルール `docs/rules/Diseno_AI協働運用ルール_20260812.md` §6 を全項目満たすこと。

- A-3-1 空状態とエラー状態の見た目が分離している（読み取り失敗と0件が区別できる）
- A-3-2 ユーザー向け文言に内部コード（`RLS_VIOLATION` 等）が出ない
- A-3-3 実行不能な案内を出さない（案内した操作の手段が同じ画面に実在する）
- A-3-4 文言がi18n辞書経由（ブランド固有名詞は例外）。ハードコード文言ゼロ
- A-3-5 デザイン方向性は**実装前に検収者へ提示して合意**する。
  主要3画面（register / connect / complete）のビジュアルモックを
  Vercel Preview またはスクリーンショットで提示し、検収者と人間の合意を取ってから本実装に入る

#### 採用する方向性（2026-08-18 承認）: 「静かな計器板」

- オフホワイト地＋インク黒＋アクセント1色（深い藍）。見出しは明朝系、本文はゴシック
- 余白広め・細い罫線・整列。スタイリッシュさは**装飾ではなく**、
  余白・タイポグラフィ・罫線・整列で出す（印刷物や上質な帳票の信頼感）
- 中小企業の経営者が「自社で使いたい」と感じる落ち着きを基準にする

**禁止事項（AI感の排除）**: グラデーション／ネオン／グロー／sparkle系アイコン／
紫系のAI定番配色／ダークな端末風UI。

### A-4 再連携動線

- A-4-1 `status = reauth_required` の接続に「要再連携」表示と**再接続ボタン**が出る
- A-4-2 再接続を実行すると当該接続が `active` に復帰する
- A-4-3 本番実証は、**Google側でアクセスを取り消して**（myaccount.google.com/connections）
  意図的に refresh 失敗を起こす手順で行う（2026-08-18 承認）。
  失効の発生 → `reauth_required` → 画面表示 → 再接続 → `active` 復帰 を実測ログで示す。
  当初案の「2026-08-25頃の自然失効を待つ」は、任意タイミングで再現できず日程リスクを負うため採らない

### A-5 審査準備

- A-5-1 プライバシーポリシーページが実装され、公開URLで到達できる
- A-5-2 利用規約ページが実装され、公開URLで到達できる
- A-5-3 両ページへの導線がサインアップ画面に存在する
- A-5-4 文面の法的確認は人間の関門。Google OAuth審査の申請自体は人間の合図（関門2）を待つ

## 検証と停止点

- CI全緑（`pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm run check:allowlist`）＋
  Vercel Preview 成功が前提。push後はGitHub ActionsとVercelチェックの両方を完了まで自律監視する
- 本番実測（A-1-1 / A-1-4 / A-2 / A-4-3 / A-5）は**検収者関門**
- 進行順序は plan mode → 承認 → 実装 → commit → 停止。停止点を越えて先に進まない
- A-3-5（デザインモックの合意）と A-5-4（法的確認・審査申請）は人間の判断待ちであり、
  勝手に確定させない
