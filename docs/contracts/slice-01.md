# スライス1契約書 — ウォーキングスケルトン「報告ゼロで見える」最小1本

状態: active（2026-07-02 梶谷さん承認）/ 環境: Supabaseブランチ＋Vercel preview のみ / 採点者: sprint-evaluator

## 目的

新規登録から「カレンダー＋会計CSV→タイムライン→最小会社モデル→Day0レポート＋週次＋稼働監視＋ワンタップ1種」が
本番同等環境で通ること。Sentioの核（入力ゼロで見える）が最小構成で成立する。

## スコープ / 非スコープ

IN: Ingest（カレンダー・会計CSV・稼働監視・外部S0の一部: e-Stat/Places/gBizINFO/jGrants）/ State4構成 /
Scanner（deviation/deadline/external/monitor）＋高速路 / Investigator（フルハーネス）/ scan→investigate→findingsパイプライン /
Day0バッチ / 週次メール / パルス(メールで代替可) / ワンタップ①
OUT: Slack/CW/Instagram/Gmail・従業員接点・月次レーダー・「Sentioに聞く」・プランentitlement・LINE配信・
外部OAuth実画面のE2E（コントラクトテスト＋フィクスチャ注入で代替。実OAuthは手動スモーク1回のみ）・
trend/silence scan（#1発注間隔伸長・#4残業漸増・#7会議消失）→スライス2に移管。
理由: spec/03がチャット非依存への全面再設計中であり、旧仕様での実装は確実に作り直しになるため

## 受け入れ基準（全passが必要）

### A. 登録〜Day0（コア体験）

A1 新規登録→10分以内にDay0レポートメールが着信する（テスト受信箱）
A2 Day0レポートに8ブロック中3ブロック以上が実データで含まれる（URL解析＋S0データ由来）
A3 Day0本文の全事実に出所表記がある / 断定表現がない（Evaluator Day0変形の適用）
A4 登録時懸念を入力した場合、⑦初期仮説ブロックが懸念に言及する
A5 URL到達不能な会社でも登録が完了しレポートが届く（crawl失敗の隔離）

### B. Ingest（冪等・遡及）

B1 会計CSV投入→transactionイベントがタイムラインに存在、金額合計がCSVと一致
B2 同一CSVの再投入で件数が増えない（冪等）/ B3 修正済みCSVの再投入は差分行のみ新イベント
B4 カレンダーはフィクスチャ注入で過去12ヶ月のscheduleイベントが存在（occurred_atが過去）
B5 S0データがcompany_id=nullで1回のみ存在（2社目登録で重複しない）
B6 S2テーブルにallowlist外カラムが存在しない（schema検査）

### C. State

C1 baselinesが最低観測数を満たす指標のみis_established=true
C2 company_summaryが生成され、章立て・トークン上限に適合
C3 記憶パケット編成器が上限内のパケットを返す（超過時は優先度順に切詰め）

### D. Sense

D1 合成会社の仕込み陽性7件中6件以上を検知（metric change scanにより#3/#4/#6も検知可能。trend/silence scanはsrc/sense/scanner.tsに存在するがEdge Function非スコープ） / D2 誤検知2件以下（陰性コントロール#5を検知したら即fail）
D3 全FindingがEvaluator5基準の判定ログを持ち、reviseは2回以内
D4 immediateのFindingが機械的事実（monitor/期日）のみである
D5 各Findingの全主張が証拠イベントIDに解決できる（リンク切れゼロ）
D6 Finding台帳: 同一事象の再検知が新規Findingでなくupdateになる

### E. Act

E1 週次メールが構成順（ダイジェスト→Finding0〜2→続報→安定＋カバレッジ→ナッジ≤1行）に適合
E2 Findingゼロ週は安定Finding＋カバレッジ数が表示される
E3 稼働監視: プレビューサイトを意図的に落とす→アラートメールが着信、本文に解釈文がない
E4 ワンタップ①: メール内リンク→カレンダー仮登録の下書きが生成される。承認タップまで何も送信・登録されない
E5 静音時間帯: 23–6時の非例外アラートが翌朝に集約される（時刻モックで検証）

### F. セキュリティ（固定基準）

F1 トークンがVault以外（テーブル・ログ・コード）に存在しない（grep＋スキーマ検査）
F2 全新テーブルにRLSが有効 / F3 受信Webhookが不正署名を拒否する
F4 gitleaksがリポジトリ全体で検出ゼロ / F5 プレビュー環境に本番Secretsが存在しない

### D+. パイプライン結合（G2 fail是正で追加 2026-07-23）

D+1 合成会社データでscanを実行するとfindingsテーブルに1件以上のレコードがINSERTされること
D+2 週次レポートに表示されるFinding件数と、findingsテーブルの該当期間のレコード数が一致すること
D+3 Evaluatorが出力品質を判別できること（陽性/陰性コントロール）:
  - 良質な出力（実データに基づく数字・出所・暫定推察明示）→ scoresに5基準が揃い、overall_pass=true
  - 曖昧な出力（一般論のみ・数字なし・出所なし）→ scoresに5基準が揃い（{}でないこと）、基準5「具体」を含む複数基準がfailしてoverall_pass=false
  - scripts/test-evaluator-direct.ts で検証（Evaluator単体テスト。E2EではGeneratorが常に具体的出力を生成するため陰性コントロール不可）

### F+. フックガード健全性（2026-07-23追加）

F+1 全PreToolUseフックがfail-closed: スクリプト実行失敗時にツール実行がブロックされること（exit 2）
F+2 以下4項目が各3回連続で同一結果:
  - .envの読み取り試行 → 毎回ブロック
  - 本番Ref操作試行 → 毎回ブロック
  - 秘密パターンを含む書き込み試行 → 毎回ブロック
  - フックスクリプト不在時のツール実行 → 毎回ブロック（fail-closed）

### G. 手動スモーク（sprint-evaluator対象外・人間1回）

G1 実Googleアカウントでカレンダー接続→当日中にscheduleイベント到着
G2 デモゲート: 梶谷さんがDay0レポートと週次を読み、「見える」体験として成立するかを判定（体験のみ・機能はA〜Fで保証済み）

## 進め方

plan mode→契約レビュー→TDD（B/C/D/Fはテスト先行）→実装→hooks/CI→sprint-evaluator採点→
エンジン評価スイート（D1-D2を含む回帰）→G。失敗時はgap報告→修正→再採点。
