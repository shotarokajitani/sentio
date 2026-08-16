-- 00021: 旧スキーマ16テーブルの削除（方針A・2026-08-17 決定）
--
-- 背景:
--   本番 public には4月構築の旧プロジェクト由来テーブルが残存していた（診断キット分岐C）。
--   pg_policies の実測（docs/spec/07_open_items.md）でテナント越境は無いことを確認済みで、
--   緊急性は無かったが、新スキーマとの共存を続ける理由も無くなったため削除する。
--   バックアップは人間がJSONスナップショットで取得済み（リポジトリ外に保存・2026-08-17）。
--
-- 対象16テーブル = 診断キットQ3の「旧スキーマ: 残存」14件 ＋「想定外」2件
--   （api_keys / error_logs）。想定外2件も処遇判断の対象として同時に削除する。
--
-- 現行コードからの参照が無いことは確認済み:
--   src/ · supabase/functions/ · scripts/ · shared/ · tests/ を
--   `from("<旧テーブル名>")` で全走査して0件。
--
-- ---------------------------------------------------------------------------
-- なぜ「削除順の指定」でも「CASCADE」でもなく、単一文の複数テーブルDROPなのか
-- ---------------------------------------------------------------------------
-- PostgreSQL の DROP TABLE は、複数テーブルを1文で指定した場合、
-- **指定した集合の内部で閉じているFK依存をまとめて解決する**。
-- 削除順を人間が組む必要はなく、順序ミスによる部分適用も起きない。
--
-- 旧スキーマのFKは実測・旧定義の両面から集合内に閉じている:
--   - notification_logs.company_id -> companies(id)
--   - usage_logs / subscriptions / api_keys の company_id -> companies(id)
--   - signals.pattern_id -> patterns(id) 相当
--   いずれも参照先が本リストに含まれる。
--
-- CASCADE を採用しない理由（重要）:
--   CASCADE は**リスト外**の依存オブジェクトまで巻き込んで削除する。
--   本番の実スキーマには、リポジトリに定義が残っていない旧ビュー・旧関数が
--   存在しうる（Dashboard SQL Editor で作られたものは履歴に残らない）。
--   CASCADE だとそれらが**警告だけで静かに消える**。
--   一方 CASCADE 無しなら、リスト外に依存があった時点で
--   `cannot drop table X because other objects depend on it` で**失敗して止まる**。
--   破壊的操作は「黙って余分に消す」より「止まって気づかせる」方が安全なので、
--   fail-closed 側に倒す。
--
--   db push は各マイグレーションをトランザクションで実行するため、
--   失敗した場合は1テーブルも削除されずロールバックされる（部分適用なし）。
--   事前調査SQL（docs/runbooks/2026-08-17_legacy-drop-preflight.sql）で
--   リスト外依存が無いことを確認してから適用すること。
--
-- 冪等性: IF EXISTS により再実行安全。2回目以降は no-op。
-- ワイルドカード・pg_tables 走査は使わない（00013/00014 と同じ明示リスト原則）。

DROP TABLE IF EXISTS
  public.companies,
  public.signals,
  public.patterns,
  public.industry_patterns,
  public.competitors,
  public.conversations,
  public.questions,
  public.integrations,
  public.external_data,
  public.subscriptions,
  public.usage_logs,
  public.click_tokens,
  public.cron_job_logs,
  public.notification_logs,
  public.api_keys,
  public.error_logs;

-- ---------------------------------------------------------------------------
-- 旧cronジョブの解除
-- ---------------------------------------------------------------------------
-- 旧テーブルを参照する cron ジョブが残っていると、テーブル削除後に
-- 6時間ごと（あるいはその job のスケジュールごと）に静かに失敗し続ける。
-- マイグレーション適用は成功するため、cron.job_run_details を見ない限り気づけない。
--
-- 本番の cron.job 実測結果（cron_jobs_all）で sync-connections 以外のジョブが
-- 見つかった場合は、ここに cron.unschedule('<jobname>') を明示リストで追加する。
-- 2026-08-17 時点では実測待ちのため未記載。
-- sync-connections は新スキーマ側のジョブなので**解除しない**。
