# Step 2: 梶谷さん側タスク（並行実行・各10〜30分）

1. 申請キュー着手: Google審査の状況確認 → Slack Marketplace申請開始 → Metaアプリ審査（Instagram）。
2. K4整備: パスワードマネージャに全ルート認証を集約（Supabase/Vercel/Stripe/Google Cloud/Meta/レジストラ/GitHub）。
   全て2FA有効化＋復旧コード保存＋緊急アクセスキット（1Passwordならエマージェンシーキット）作成。
3. Anthropic: dev/prod APIキー分割、ワークスペース支出上限とアラート設定。
4. ローカル原本の秘密スキャン（1行）:
   docker run --rm -v "対象フォルダの絶対パス:/scan" zricethezav/gitleaks:latest detect --source /scan --no-git -v
   検出があれば当該鍵をrunbook手順でローテーションし、文書から値を削除。
5. GitHubリポジトリ diseno/sentio（または既存sentio）に本足場をコミット。既存コードは archive/legacy ブランチへ退避。
