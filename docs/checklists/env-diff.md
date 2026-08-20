# 環境差分チェックリスト

新スキーマ・新コネクタ・新サービス着手時に必ず点検する。
ローカルで動いても本番で動かない障害の型（Lauda実績: 1日で2件発生）。

正本: `docs/rules/Diseno_AI協働運用ルール_20260812.md` §5

---

- [ ] **Exposed schemas**: 新スキーマは Supabase Dashboard の API Settings に登録したか
      （未登録は PGRST106 が「静かな空状態」として現れる）
- [ ] **PostgreSQL のメジャーバージョン**: 本番の実測値と `supabase/config.toml` の
      `major_version` が一致しているか（**config.toml は宣言であって実測ではない**。
      同ファイルのコメント自身が remote で `SHOW server_version;` を実行して確認せよと書いている）。
      版に依存する構文を使う migration は、ローカルで通っても本番で**構文エラー**として落ちる。

      ```sql
      select version();
      -- または Settings → Infrastructure
      ```

      | 項目                      | 値         | 実測日 | 実施者 |
      | ------------------------- | ---------- | ------ | ------ |
      | 本番の PostgreSQL バージョン | **未実施** |        |        |

      **版に依存している箇所（2026-08-20 時点）**:
      `00023` の `NULLS NOT DISTINCT`（**PostgreSQL 15 以降**）。
      `baselines` の自然キー `(company_id, metric_key, entity_id, granularity)` は
      `entity_id` が NULL を取りうるため、この構文が無いと一意索引の意味が成立しない。
      `00023` は実行時に `server_version_num` を見て 15 未満なら**理由を書いて停止**する
      （素の `CREATE INDEX` だとパース時に落ちてメッセージが読めないため動的SQLにしてある）。

- [ ] **Extensions**: 本番プロジェクトで必要拡張が有効か（ローカル supabase start の
      自動有効化に騙されない）
- [ ] **env / Secrets**: Vercel env と Supabase Function Secrets の両方に、最新値が
      入っているか（Updated 日時で照合。登録先プロジェクトの取り違えに注意）
- [ ] **DNS / ドメイン認証**: ネームサーバー切替をまたいだドメインは Resend 等の
      認証が Failed に転落していないか（メール疎通で検知できる）
- [ ] **RLS**: 新テーブルへの書き込み経路には INSERT/UPDATE ポリシーが実在するか
      （不在は「静かな0件」として現れる。保存 API はエラー時に必ずユーザーに失敗を表示）
- [ ] **redirect URI**: OAuth は本番 URL＋localhost の2本。プレビュー環境では検証不可を前提化
