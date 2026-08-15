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

| 項目 | 値 |
| --- | --- |
| 本番 Project Ref | `kwpldqbnkraftaahnpev`（CLI直接操作は絶対禁止。反映はCIのみ） |
| リポジトリ | `github.com/shotarokajitani/sentio`（public読み取り） |
| CI | `ci.yml`（PR時: gitleaks/verify/integration/edge-functions） |
| デプロイ | `deploy.yml`（main push時: verify→deploy-migrations→deploy-functions） |
| Supabase CLI | **2.113.0 固定**（latestは破壊的変更で事故実績。dependabot #5 はclose済み） |
| migration | 00001〜00020 本番適用済み（2026-08-15時点） |
| Vaultシークレット名 | `sentio_supabase_url` / `sentio_service_role_key`（00020の正本と一致必須） |
| cron | `sync-connections`、`0 0,6,12,18 * * *`（UTC）＝JST 9/15/21/3時 |
| SQL Editor | https://supabase.com/dashboard/project/kwpldqbnkraftaahnpev/sql/new |

## 4. 定型の検収手順（Cowork）

1. Claude Code の報告を受けたら、クラウドで `git fetch origin pull/<N>/head:prN` して
   diff 実物を読む（migration・workflow・テストは全文）
2. CI は WebFetch で run ページを開き、**全ジョブの結果・実行時間・skip有無**を確認
   （integrationジョブが30秒台で終わっていたら空洞化を疑う。正常は3分台）
3. 判定と根拠を人間に返し、Claude Code へ貼るコピペ用指示文を毎回作る
4. 検収状況の変化は claude.ai プロジェクトナレッジのメモを更新して固定する

## 5. 現在地と残作業（2026-08-16 02:30 JST時点）

**完了**: フェーズ1（コミット分離・hooks強化）／フェーズ2（RLS 00019・rls.test.ts
実クエリ化・CI完全化）／フェーズ3（分岐C確定・00013/00014/00015修正・CI repair step・
00020 Vault化）。migration 00001〜00020 本番適用済み、17function デプロイ済み、
prereq-check seq 1〜8 OK、Vaultシークレット2件登録済み（16:13 UTC）。

**残作業**:
1. **seq 9**（cron疎通）: 初回発火 2026-08-15 18:00 UTC（JST 8/16 03:00）以降に
   `docs/runbooks/2026-08-15_token-refresh-prereq-check.sql` を再実行して確認
2. **検証A〜D**: `docs/runbooks/2026-08-16_token-refresh-verification-run.md`（PR #13）。
   STEP 1で対象選定→検収者確認→STEP 2〜4。STEP 3のみ本番書き込み（人間確認必須）
3. **PR #13 の merge**: 検証完了後（検収者判断済み）
4. **dependabot 残5件**（#2/#3/#4/#6/#7）: フェーズ完了後にCI緑確認の上で一括処理
5. **旧スキーマ16テーブルの処遇**（削除/退避/残置）: 人間の関門。`api_keys` の
   中身確認を優先（`docs/spec/07_open_items.md` に実測記録済み）
6. **PC買い替え（8/20以降）**: 移行チェックリストを作成して支援する
   （repo clone・.env移送・Node/pnpm/Supabase CLI/Docker導入）。
   それまでディスク残1.5GBのため、ローカル検証はCI代替で運用

## 6. 過去の主要な実測記録（誤読防止）

- 旧スキーマ16テーブルは全件RLS有効・ポリシーは自社スコープで越境不可（実測済み）。
  authenticated の書き込みグラントは4月からの既存状態（Supabaseビルトイン付与）で
  今回の修復の後退ではない
- GUC方式（ALTER DATABASE ... SET app.settings.*）は本番で 42501 により**経路ごと不可**。
  秘密は Vault 一本化（00020）が現行の正
- `expires_at` が動かない＝故障ではない（リフレッシュは期限5分前からのみ）。
  検証の読み方は `2026-08-16_token-refresh-verification-run.md` 冒頭の表が正本
