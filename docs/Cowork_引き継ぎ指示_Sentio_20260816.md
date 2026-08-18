# Cowork 引き継ぎ指示 — Sentio（2026-08-16版）

Sentio の Cowork セッションをブートストラップする正本。新しい Cowork セッションを
開始したら、まずこのファイルと `CLAUDE.md`／`docs/rules/Diseno_AI協働運用ルール_20260812.md`
を読み、下記の役割・経路・関門に従って自走すること。

## 0. セッション開始時のチェックリスト

1. デスクトップアプリで `C:\Users\shota\sentio` が**接続済み**であることを確認
   （未接続なら device_request_folder_access で依頼。デスクトップのウィンドウが
   開いていないとダイアログが出ない点に注意）
2. claude.ai「Sentio」プロジェクト配下のセッションであることを確認
   （プロジェクトナレッジの最新の検収状況メモで現在地を復元する）
3. リポジトリ状態の実在確認: `git ls-remote https://github.com/shotarokajitani/sentio.git`
   （public読み取り可。クラウドサンドボックスから clone して照合できる）

## 1. 役割分担（実行と検収の分離・変更不可）

- **Cowork（このセッション）= 検収者**:
  - Claude Code の完了報告を**実在で照合**する（PRのdiff実物・CI runのジョブ実態・
    実行時間の整合まで見る。申告は信用しない）
  - Supabase Dashboard の**読み取り専用SQL代行**（Chrome経由。§3の実測知見に従う）
  - 指示文の作成（人間が Claude Code へ貼るコピペ用テキストを毎回用意する）
- **Claude Code（ローカル `claude`）= 実装者**: 実装・commit/push・CI/Vercel自律監視
- **人間（梶谷さん）= 3関門のみ**: ①本番適用の合図（push可） ②秘密・課金・
  外部アカウント操作 ③本番実測の最終確認

## 2. 実行経路の実測知見（このセッションで確定した事実）

- **クラウドサンドボックス**: repoはpublicのため clone/fetch/diff 可能（検収に使う）。
  **push・gh は不可**（認証なし）。push系は Claude Code の担当
- **device_bash（PC側シェル）は起動失敗の実績あり**（"isolated Linux environment
  failed to start" ×2回）。PC上のファイルは device_stage_files / device_commit_files で
  読み書きする。**git操作はPC側では実行できない**
- **Chrome代行（Supabase SQL Editor）**: 実行可能だが不安定要素が3つ（実測済み）:
  1. 安全判定（classifier）は操作ごとに変動する。ブロックされても後で通ることがある。
     一度の拒否で「不可」と断定しない
  2. **長文SQL（1,000字超）のキー入力はエディタをフリーズさせる** → クエリは短く分割
     するか、判定ロジックをCowork側で持ち軽量SELECTだけ流す
  3. エディタのフォーカスが外れるとキー入力がショートカットに吸われ「Connect」
     モーダルが開く → Escで閉じ、find で "Editor content" のrefを取得してから click
- **本番への書き込みは Cowork からも原則行わない**。読み取り専用SELECTのみ代行。
  書き込み（例: 検証Dのセンチネル UPDATE 1文）は人間の明示確認を挟む

## 3. 環境定数

| 項目                | 値                                                                          |
| ------------------- | --------------------------------------------------------------------------- |
| 本番 Project Ref    | `kwpldqbnkraftaahnpev`（CLI直接操作は絶対禁止。反映はCIのみ）               |
| リポジトリ          | `github.com/shotarokajitani/sentio`（public読み取り）                       |
| CI                  | `ci.yml`（PR時: gitleaks/verify/integration/edge-functions）                |
| デプロイ            | `deploy.yml`（main push時: verify→deploy-migrations→deploy-functions）      |
| Supabase CLI        | **2.113.0 固定**（latestは破壊的変更で事故実績。dependabot #5 はclose済み） |
| migration           | **00001〜00022 本番適用済み**（00022＝update_vault_secret修正・2026-08-18） |
| Vaultシークレット名 | `sentio_supabase_url` / `sentio_service_role_key`（00020の正本と一致必須）  |
| cron                | `sync-connections` **のみ**、`0 0,6,12,18 * * *`（UTC）＝JST 9/15/21/3時    |
| SQL Editor          | https://supabase.com/dashboard/project/kwpldqbnkraftaahnpev/sql/new         |

## 4. 定型の検収手順（Cowork）

1. Claude Code の報告を受けたら、クラウドで `git fetch origin pull/<N>/head:prN` して
   diff 実物を読む（migration・workflow・テストは全文）
2. CI は WebFetch で run ページを開き、**全ジョブの結果・実行時間・skip有無**を確認
   （integrationジョブが30秒台で終わっていたら空洞化を疑う。正常は3分台）
3. 判定と根拠を人間に返し、Claude Code へ貼るコピペ用指示文を毎回作る
4. 検収状況の変化は claude.ai プロジェクトナレッジのメモを更新して固定する

## 5. 現在地と残作業（2026-08-18 時点・/connectスライス完了）

**/connectスライス完了。検証A〜D 完走（2026-08-18）。**
初回OAuth連携を本番で作成し（`/register/complete?events=15`）、
**B-s2-1 / B-s2-3 を本番実証**。B-s2-2 は本番未発火（CI統合テストで実証済み）。
実測記録は `docs/runbooks/2026-08-07_token-refresh-verification.md` 冒頭。

この過程で本番の重大バグを1件検出・修正した: `update_vault_secret` が
`permission denied for table secrets` で **00017 適用以降ずっと動いていなかった**
（＝トークンリフレッシュの保存が失敗し続けていた）。`00022` で修正し、実トークンで実証済み。
カタログ参照（`has_function_privilege`）では捕まらず、実DBに対して実際に呼ぶ
統合テストで初めて顕在化した。

**CC指示書_03 のフェーズ1〜3も完了。** フェーズ1（コミット分離・hooks強化）／
フェーズ2（RLS 00019・rls.test.ts実クエリ化・CI完全化）／フェーズ3（分岐C確定・
00013/00014/00015修正・CI repair step・00020 Vault化）。
migration **00001〜00022 本番適用済み**、17function デプロイ済み、
Vaultシークレット2件登録済み（2026-08-15 16:13 UTC）。

**前提確認は seq 1〜9 すべて完了**（`2026-08-15_token-refresh-prereq-check.sql`）。
seq 9（cron疎通）は 2026-08-18 時点で **10/10 成功**。
⇒ `00020` の「Vaultから秘密取得 → `net.http_post` → Edge Function 呼び出し」が
本番で継続稼働している。GUC方式が42501で塞がれた後に選んだVault方式が機能している。

> ⚠️ このSQLは **カタログ参照（`has_function_privilege`）に留まる**点に注意。
> 「関数が在る・実行できる」しか見ておらず、**正しく動くことは保証しない**。
> 実際 `update_vault_secret` は seq1〜4 が全てOKの状態で壊れていた（00022で修正）。
> 関数の動作確認は実DBに対して実際に呼ぶ統合テストで担保すること。

### 前提待ち — なし（2026-08-18 時点）

検証A〜Dは完走した。着手を止めている前提条件は無い。

**ただし2026-08-25 04:41 UTC 頃に、検証用接続の refresh_token が7日失効する。**
同意画面がテスト中（外部）のため。以降の cron 実行で `status = reauth_required` に
落ちる見込みだが、**これは故障ではなく B-s2-2（fail-closed）の自然な本番実証**になる。
発生したらその旨を記録し、`/connect` に「要再連携」バッジと「再接続」ボタンが
出ることも確認すること。本番公開（Google審査）の要否は `07_open_items.md` の未確定項目。

### バックログ

**2026-08-18 時点。** 完了3件と、着手可能1件・イベント駆動1件・日付ゲート1件。

1. ~~dependabot 残5件~~ → **2026-08-17 に全件merge済み**（#2/#3/#4/#6、および
   #7を作り直した#16）。`actions/checkout@v7` / `actions/setup-node@v7` /
   `pnpm/action-setup@v6` / `gitleaks/gitleaks-action@v3` /
   `@anthropic-ai/sdk@0.116.0` / `@supabase/supabase-js@2.112.3`。
   #5（`supabase/setup-cli` major更新）は**2.113.0固定方針と衝突するためclose済み**。
   同種の更新が再度上がっても同じ理由でcloseする。
   **注意**: `gitleaks-action@v3` は組織アカウントでは `GITLEAKS_LICENSE` が必要。
   現在は個人アカウントのため不要だが、組織へ移管すると秘密検査が止まる
2. ~~旧スキーマ16テーブルの処遇~~ → **2026-08-18 に削除完了・検収合格（方針A）。**
   `00021` で旧16テーブルDROP＋旧cronジョブ7件のunschedule。
   適用後確認SQLで**旧16件消滅・新12件無傷・想定外なし・cronは sync-connections のみ・
   履歴21件で最新00021**を全行OKで実測。
   **バックアップJSONは取り違えで未取得だったが、旧DBの実データはテスト会社1件のみ
   （実ユーザーゼロ）と削除前に確定しており、影響なしと検収済み。**
   記録は `docs/spec/07_open_items.md`（クローズ済み）
3. **【前提待ち・イベント駆動】キーローテーション時のVault更新**: `service_role` キーを更新したら
   `sentio_service_role_key` も **`update_vault_secret` で**更新する
   （`store_vault_secret` の再実行は禁止＝同名重複で
   `read_vault_secret_by_name` が曖昧エラーになる）。忘れるとcronだけが静かに止まる。
   手順は `docs/runbooks/2026-08-15_vault-secret-setup-procedure.md`
4. **【着手可能】`/register` と `/connect` のUIデザイン改善**:
   現状は動作確認用の最小実装（インラインstyle、装飾のみの入力欄、
   `/register` の会社名・URL欄はどこにも送信されない）。
   検証A〜Dが完走し機能面の疎通が取れたので、体験の作り込みに進める段階。
   認証スライス（`/api/connections` の未認証アクセス修正・`07_open_items.md`）と
   同時に扱うと、company_id のハードコード解消とまとめて設計できる
5. **【前提待ち・8/20以降】PC買い替え**: 移行チェックリストを作成して支援
   （repo clone・.env移送・Node/pnpm/Supabase CLI/Docker導入）。
   移行完了でローカル `supabase start` / `db reset` が復活し、
   下記「環境の制約」が解消する見込み

### 環境の制約（運用上の注意）

ローカルのディスクが逼迫しており、**2026-08-16 に0バイト到達で `git rebase` が失敗**した
（`Out of diskspace` で作業ツリーのファイルが0バイトに破損。`git restore` で復旧済み・
コミット済みの内容に損失なし）。キャッシュ削除で回復したが、
**ローカルの `supabase start` / `db reset` は引き続き不可**。
スキーマ検証はCIの `integration` ジョブ（`supabase db reset` を実行）で代替すること。

## 6. 過去の主要な実測記録（誤読防止）

- 旧スキーマ16テーブルは全件RLS有効・ポリシーは自社スコープで越境不可（実測済み）。
  authenticated の書き込みグラントは4月からの既存状態（Supabaseビルトイン付与）で
  今回の修復の後退ではない。
  **この安全性の確認があったからこそ削除は「緊急対応」ではなく計画的な整理として
  扱えた**（2026-08-17に方針Aで削除決定・00021で2026-08-18に削除完了）。
  削除の決め手は越境リスクではなく、`api_keys` が秘密をテーブル保持する旧設計だったこと。
  **旧cronジョブ7件（うちメール系2件が4月からactive）も同時に解除済み。**
  実送信の調査は2026-08-18にクローズ: バックアップJSONは取り違えで未取得だったが、
  旧DBの実データはテスト会社1件のみ（実ユーザーゼロ）のため送信先は開発者自身に限られ、
  実ユーザーへのリスクは構造的に存在しなかった
- GUC方式（ALTER DATABASE ... SET app.settings.*）は本番で 42501 により**経路ごと不可**。
  秘密は Vault 一本化（00020）が現行の正
- `expires_at` が動かない＝故障ではない（リフレッシュは期限5分前からのみ）。
  検証の読み方は `2026-08-16_token-refresh-verification-run.md` 冒頭の表が正本
