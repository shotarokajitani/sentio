---
name: migration
description: Supabaseマイグレーションを作成・変更するとき、またはテーブル/カラム/RLSを追加するときに必ず使用。
---
# マイグレーション手順
1. docs/spec/01（エンベロープ）と allowlist.json を読む
2. supabase/migrations/ にタイムスタンプ付きSQLを作成。1目的=1ファイル
3. 新テーブルは必ず: RLSポリシー / company_id（S0系はNULL許可）/ created_at を同時定義
4. S2系テーブルへのカラム追加は allowlist.json に先に追記し、schema-reviewerの検査対象にする
5. ローカルで supabase db reset →型生成→単体テスト→コミット。本番適用はCIのみ
## Gotchas
- vault.secretsを直接触らない（security definer関数経由のみ）
- 列挙型の変更はDROPを伴いやすい。event_type/sensitivityはCHECK制約＋参照テーブルで管理
- インデックスは (company_id, occurred_at) を基本に。event_idにユニーク制約必須
