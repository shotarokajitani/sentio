# 環境差分チェックリスト

新スキーマ・新コネクタ・新サービス着手時に必ず点検する。
ローカルで動いても本番で動かない障害の型（Lauda実績: 1日で2件発生）。

正本: `docs/rules/Diseno_AI協働運用ルール_20260812.md` §5

---

- [ ] **Exposed schemas**: 新スキーマは Supabase Dashboard の API Settings に登録したか
      （未登録は PGRST106 が「静かな空状態」として現れる）
- [ ] **Extensions**: 本番プロジェクトで必要拡張が有効か（ローカル supabase start の
      自動有効化に騙されない）
- [ ] **env / Secrets**: Vercel env と Supabase Function Secrets の両方に、最新値が
      入っているか（Updated 日時で照合。登録先プロジェクトの取り違えに注意）
- [ ] **DNS / ドメイン認証**: ネームサーバー切替をまたいだドメインは Resend 等の
      認証が Failed に転落していないか（メール疎通で検知できる）
- [ ] **RLS**: 新テーブルへの書き込み経路には INSERT/UPDATE ポリシーが実在するか
      （不在は「静かな0件」として現れる。保存 API はエラー時に必ずユーザーに失敗を表示）
- [ ] **redirect URI**: OAuth は本番 URL＋localhost の2本。プレビュー環境では検証不可を前提化
