-- パイプライン初回手動実行（A-1）の計測SQL
--
-- 手順書: docs/runbooks/2026-08-19_pipeline-first-run.md
-- 実行者: 人間（Supabase Dashboard > SQL Editor）
-- 実行方法: **§ごとにブロック単位でコピペして実行する。** 各ブロックは1グリッドで返る。
-- 安全性: 全ブロック読み取り専用。SELECT のみ。DDL・DML・SET ROLE を含まない。
--         秘密の値は返さない。イベント本文（metrics.title 等）も返さない。
--
-- 列名はすべて 00001〜00015 のマイグレーション定義と突き合わせ済み（2026-08-19）。
--   events          : event_id, company_id, occurred_at, period_start, period_end,
--                     ingested_at, source, event_type, actor_ref, entity_refs, metrics, sensitivity
--   baselines       : id, company_id, metric_key, entity_id, granularity, stats,
--                     min_obs, is_established, updated_at
--   narratives      : id, company_id, category, topic, content, confidence,
--                     source_event_ids, last_confirmed_at, decayed_at
--   company_summary : company_id, content, token_count, chapters, generated_at
--   findings        : id, company_id, status, urgency, what, evidence_event_ids, confidence,
--                     hypotheses, next_actions, eval_log, parent_finding_id, created_at, updated_at
--   delivery_log    : id, company_id, finding_ids, sent_at, opened, acted,
--                     channel, delivery_type, content, status, created_at   （00015適用後・frameは無い）
--   connections     : id, company_id, provider, vault_secret_id, scopes, status, last_refresh, expires_at
--                     （created_at は存在しない。2026-08-18に本番で顕在化済み）
--
-- 「手順書に載せるSQLは、書いた時点でマイグレーションの列定義と突き合わせること」
-- （.claude/skills/gotchas）。実行者が人間で実行先が本番のとき、間違いは本番のエラーで発見される。
--
-- 【未実行の申告】このSQLは**どの環境でも一度も実行していない**。
--   起草環境に psql も Docker（supabase start）も無く、本番へのCLI直接操作は絶対規則で禁止のため、
--   構文検証は「列定義との突き合わせ」と目視までしか行っていない。
--   §0 が構文エラーで落ちた場合は、そのエラーメッセージを添えて報告すること（手順を止める必要はない）。


-- =====================================================================
-- §0  実行前スナップショット（STEP 0 / 全STEPの「入力」側の基準）
-- =====================================================================
WITH c AS (SELECT '197f2c0e-aef8-405d-afcc-34d23c771fcd'::uuid AS id)
SELECT 1 AS seq, 'events 総件数' AS item,
       count(*)::text AS value,
       CASE WHEN count(*) = 15 THEN 'OK (想定どおり15件)'
            ELSE 'NOTE: 15件ではない。以降の期待値を件数に読み替えること' END AS verdict
FROM events e, c WHERE e.company_id = c.id
UNION ALL
SELECT 2, 'events 種別内訳',
       coalesce(string_agg(t.event_type || '=' || t.n, ', ' ORDER BY t.event_type), '(0件)'),
       CASE WHEN count(*) = 1 AND min(t.event_type) = 'schedule'
            THEN 'OK: schedule のみ ⇒ scan が0件になるのが正常（手順書 §0.3）'
            ELSE 'NOTE: schedule 以外が在る。STEP 4 の期待値が変わる' END
FROM (SELECT e.event_type, count(*) AS n FROM events e, c
      WHERE e.company_id = c.id GROUP BY e.event_type) t
UNION ALL
SELECT 3, 'events のうち transaction 件数',
       (SELECT count(*)::text FROM events e, c
        WHERE e.company_id = c.id AND e.event_type = 'transaction'),
       CASE WHEN (SELECT count(*) FROM events e, c
                  WHERE e.company_id = c.id AND e.event_type = 'transaction') = 0
            THEN 'OK: 0件 ⇒ baselines は成立しないのが正常（MIN_OBS=5 以前の問題）'
            ELSE 'NOTE: transaction が在る。STEP 1 の期待値が変わる' END
UNION ALL
SELECT 4, 'events 最古/最新 occurred_at',
       coalesce(min(e.occurred_at)::text, '(なし)') || ' 〜 ' || coalesce(max(e.occurred_at)::text, '(なし)'),
       'INFO: STEP 6「昨日N件」の予測に使う'
FROM events e, c WHERE e.company_id = c.id
UNION ALL
SELECT 5, 'events のうち直近24hに occurred_at を持つ件数',
       (SELECT count(*)::text FROM events e, c
        WHERE e.company_id = c.id
          AND e.occurred_at >= now() - interval '2 days'
          AND e.occurred_at <= now() - interval '1 day'),
       'INFO: STEP 6 のパルス1行目の期待値。0でも正常'
UNION ALL
SELECT 6, 'baselines 件数',
       (SELECT count(*)::text FROM baselines b, c WHERE b.company_id = c.id),
       CASE WHEN (SELECT count(*) FROM baselines b, c WHERE b.company_id = c.id) = 0
            THEN 'OK: 0件から始まる' ELSE 'NOTE: 残骸あり。件数を控えてから進む' END
UNION ALL
SELECT 7, 'narratives 件数',
       (SELECT count(*)::text FROM narratives n, c WHERE n.company_id = c.id),
       CASE WHEN (SELECT count(*) FROM narratives n, c WHERE n.company_id = c.id) = 0
            THEN 'OK: 0件から始まる' ELSE 'NOTE: 残骸あり' END
UNION ALL
SELECT 8, 'company_summary 件数',
       (SELECT count(*)::text FROM company_summary s, c WHERE s.company_id = c.id),
       CASE WHEN (SELECT count(*) FROM company_summary s, c WHERE s.company_id = c.id) = 0
            THEN 'OK: 0件から始まる' ELSE 'NOTE: 既存あり。STEP 3 は上書きになる' END
UNION ALL
SELECT 9, 'findings 件数',
       (SELECT count(*)::text FROM findings f, c WHERE f.company_id = c.id),
       CASE WHEN (SELECT count(*) FROM findings f, c WHERE f.company_id = c.id) = 0
            THEN 'OK: 0件から始まる' ELSE 'NOTE: 残骸あり' END
UNION ALL
SELECT 10, 'delivery_log 件数',
       (SELECT count(*)::text FROM delivery_log d, c WHERE d.company_id = c.id),
       'INFO: STEP 6 でこの値が +1 になるのが期待値'
UNION ALL
SELECT 11, 'connections 状態',
       coalesce((SELECT string_agg(cn.provider || '=' || cn.status, ', ' ORDER BY cn.provider)
                 FROM connections cn, c WHERE cn.company_id = c.id), '(接続なし)'),
       CASE WHEN (SELECT count(*) FROM connections cn, c
                  WHERE cn.company_id = c.id AND cn.status = 'active') > 0
            THEN 'OK: active ⇒ 直近7日のカレンダーが取り込まれている前提でよい'
            ELSE 'NOTE: active でない ⇒ 取り込みは止まっている。STEP 6 で「昨日0件」でも正常' END
UNION ALL
SELECT 12, 'budget_usage 件数',
       (SELECT count(*)::text FROM budget_usage b, c WHERE b.company_id = c.id),
       'INFO: 0件が想定。investigate は今回呼ばれないので増えない'
ORDER BY seq;


-- =====================================================================
-- §1  STEP 1（state-baselines）直後
-- =====================================================================
-- 期待: 0行のまま（Function が 500 で落ちるため）。
--       行が入っていた場合、その行の実列を見て「本番のスキーマがリポジトリと違う」を確認する。
WITH c AS (SELECT '197f2c0e-aef8-405d-afcc-34d23c771fcd'::uuid AS id)
SELECT 1 AS seq, 'baselines 件数' AS item,
       (SELECT count(*)::text FROM baselines b, c WHERE b.company_id = c.id) AS value,
       CASE WHEN (SELECT count(*) FROM baselines b, c WHERE b.company_id = c.id) = 0
            THEN 'OK: 予測どおり（不具合#1 を実測で確定）'
            ELSE 'UNEXPECTED: 行が入った。手順書 §3 の想定外A/B へ' END AS verdict
UNION ALL
SELECT 2, 'baselines 明細',
       coalesce((SELECT string_agg(
                   b.metric_key || ' / granularity=' || b.granularity ||
                   ' / established=' || b.is_established ||
                   ' / stats=' || coalesce(b.stats::text, 'null'), ' | ')
                 FROM baselines b, c WHERE b.company_id = c.id), '(0行)'),
       'INFO'
UNION ALL
-- 本番の baselines に median 等の列が「実在するか」を直接見る。
-- 00003 どおりなら 0。1以上なら Dashboard 直流し等でリポジトリ外の変更が入っている。
SELECT 3, 'baselines に median/iqr/p25/p75/observation_count が実在する数',
       (SELECT count(*)::text FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'baselines'
          AND column_name IN ('median','iqr','p25','p75','observation_count')),
       CASE WHEN (SELECT count(*) FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'baselines'
                    AND column_name IN ('median','iqr','p25','p75','observation_count')) = 0
            THEN 'OK: 0 ⇒ 手順書 §0.1 の診断が本番で裏付けられた'
            ELSE 'UNEXPECTED: 列が在る。リポジトリ外の変更を調査すること' END
UNION ALL
-- ON CONFLICT (company_id, metric_key) を成立させる一意索引の有無（PK id は除外して数える）
SELECT 4, 'baselines の一意索引（PK除く）',
       coalesce((SELECT string_agg(ix.relname, ', ') FROM pg_index i
                 JOIN pg_class t  ON t.oid = i.indrelid
                 JOIN pg_class ix ON ix.oid = i.indexrelid
                 WHERE t.relname = 'baselines' AND i.indisunique AND NOT i.indisprimary), '(なし)'),
       CASE WHEN (SELECT count(*) FROM pg_index i
                  JOIN pg_class t ON t.oid = i.indrelid
                  WHERE t.relname = 'baselines' AND i.indisunique AND NOT i.indisprimary) = 0
            THEN 'OK: (なし) ⇒ ON CONFLICT "company_id,metric_key" は原理的に成立しない'
            ELSE 'NOTE: 一意索引が在る。対象列を確認すること' END
ORDER BY seq;


-- =====================================================================
-- §2  STEP 2（state-narratives）直後
-- =====================================================================
-- 期待: 0行のまま。
WITH c AS (SELECT '197f2c0e-aef8-405d-afcc-34d23c771fcd'::uuid AS id)
SELECT 1 AS seq, 'narratives 件数' AS item,
       (SELECT count(*)::text FROM narratives n, c WHERE n.company_id = c.id) AS value,
       CASE WHEN (SELECT count(*) FROM narratives n, c WHERE n.company_id = c.id) = 0
            THEN 'OK: 予測どおり（不具合#2 を実測で確定）'
            ELSE 'UNEXPECTED: 行が入った。該当行を控えて報告。削除はしない' END AS verdict
UNION ALL
SELECT 2, 'narratives に key / updated_at / source_event_id が実在する数',
       (SELECT count(*)::text FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'narratives'
          AND column_name IN ('key','updated_at','source_event_id')),
       CASE WHEN (SELECT count(*) FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'narratives'
                    AND column_name IN ('key','updated_at','source_event_id')) = 0
            THEN 'OK: 0 ⇒ 手順書 §0.2 の診断が本番で裏付けられた'
            ELSE 'UNEXPECTED: 列が在る。リポジトリ外の変更を調査すること' END
UNION ALL
SELECT 3, 'narratives 明細',
       coalesce((SELECT string_agg(n.category || ' / ' || n.topic || ' / conf=' || n.confidence, ' | ')
                 FROM narratives n, c WHERE n.company_id = c.id), '(0行)'),
       'INFO'
ORDER BY seq;


-- =====================================================================
-- §3  STEP 3（state-summary）直後
-- =====================================================================
-- 期待: 1行。operations 章に schedule 15件が反映され、financial/people は「(no ... data)」。
WITH c AS (SELECT '197f2c0e-aef8-405d-afcc-34d23c771fcd'::uuid AS id)
SELECT 1 AS seq, 'company_summary 件数' AS item,
       (SELECT count(*)::text FROM company_summary s, c WHERE s.company_id = c.id) AS value,
       CASE WHEN (SELECT count(*) FROM company_summary s, c WHERE s.company_id = c.id) = 1
            THEN 'OK' ELSE 'NG: 1行でない' END AS verdict
UNION ALL
SELECT 2, 'token_count',
       coalesce((SELECT s.token_count::text FROM company_summary s, c WHERE s.company_id = c.id), '(なし)'),
       CASE WHEN coalesce((SELECT s.token_count FROM company_summary s, c WHERE s.company_id = c.id), 0) > 0
            THEN 'OK: 1以上' ELSE 'NG: 0 は生成されていないのと同じ' END
UNION ALL
SELECT 3, 'generated_at',
       coalesce((SELECT s.generated_at::text FROM company_summary s, c WHERE s.company_id = c.id), '(なし)'),
       'OK なら実行時刻と一致すること（古い時刻なら上書きされていない）'
UNION ALL
SELECT 4, 'chapters の章数',
       coalesce((SELECT jsonb_array_length(s.chapters)::text FROM company_summary s, c
                 WHERE s.company_id = c.id AND jsonb_typeof(s.chapters) = 'array'), '(配列でない)'),
       'OK なら 5（overview/financial/operations/people/external）'
UNION ALL
SELECT 5, 'operations 章の本文',
       coalesce((SELECT ch->>'content' FROM company_summary s, c,
                 jsonb_array_elements(s.chapters) ch
                 WHERE s.company_id = c.id AND jsonb_typeof(s.chapters) = 'array' AND ch->>'key' = 'operations'), '(なし)'),
       'OK なら「15 schedule events tracked.」＝ events が summary に到達した実証'
UNION ALL
SELECT 6, 'financial 章の本文',
       coalesce((SELECT ch->>'content' FROM company_summary s, c,
                 jsonb_array_elements(s.chapters) ch
                 WHERE s.company_id = c.id AND jsonb_typeof(s.chapters) = 'array' AND ch->>'key' = 'financial'), '(なし)'),
       'OK なら「(no financial data)」＝見えていないものを見えているふりをしていない'
UNION ALL
SELECT 7, 'people 章の本文',
       coalesce((SELECT ch->>'content' FROM company_summary s, c,
                 jsonb_array_elements(s.chapters) ch
                 WHERE s.company_id = c.id AND jsonb_typeof(s.chapters) = 'array' AND ch->>'key' = 'people'), '(なし)'),
       'OK なら「(no people data)」'
ORDER BY seq;


-- =====================================================================
-- §5  STEP 5（run-sense）直後   ※ STEP 4（scan）はDBに何も書かないため §4 は無い
-- =====================================================================
-- 期待: findings 0行のまま。budget_usage も増えない（investigate が呼ばれないため）。
WITH c AS (SELECT '197f2c0e-aef8-405d-afcc-34d23c771fcd'::uuid AS id)
SELECT 1 AS seq, 'findings 件数' AS item,
       (SELECT count(*)::text FROM findings f, c WHERE f.company_id = c.id) AS value,
       CASE WHEN (SELECT count(*) FROM findings f, c WHERE f.company_id = c.id) = 0
            THEN 'OK: 予測どおり（材料が無いだけで、配線は生きている）'
            ELSE 'UNEXPECTED: Finding が生成された。STEP 4 の結果と突き合わせる' END AS verdict
UNION ALL
SELECT 2, 'findings 明細',
       coalesce((SELECT string_agg(f.urgency || ' / ' || f.status || ' / ' || left(f.what, 60), ' | ')
                 FROM findings f, c WHERE f.company_id = c.id), '(0行)'),
       'INFO'
UNION ALL
SELECT 3, 'budget_usage（本日）',
       coalesce((SELECT b.full_runs || ' full / ' || b.light_runs || ' light'
                 FROM budget_usage b, c WHERE b.company_id = c.id AND b.date = current_date), '(0行)'),
       'INFO: 0行が期待。investigate は呼ばれていないはず'
ORDER BY seq;


-- =====================================================================
-- §6  STEP 6（deliver-pulse）直後
-- =====================================================================
-- 期待: delivery_log が +1 / delivery_type='pulse' / status='sent' / email_id が非NULL。
WITH c AS (SELECT '197f2c0e-aef8-405d-afcc-34d23c771fcd'::uuid AS id),
last AS (
  SELECT d.* FROM delivery_log d, c
  WHERE d.company_id = c.id
  ORDER BY d.created_at DESC NULLS LAST
  LIMIT 1
)
SELECT 1 AS seq, 'delivery_log 総件数' AS item,
       (SELECT count(*)::text FROM delivery_log d, c WHERE d.company_id = c.id) AS value,
       '§0 seq10 の値 +1 であること' AS verdict
UNION ALL
SELECT 2, '最新行の delivery_type',
       coalesce((SELECT delivery_type FROM last), '(なし)'),
       CASE WHEN (SELECT delivery_type FROM last) = 'pulse' THEN 'OK' ELSE 'NG' END
UNION ALL
SELECT 3, '最新行の status',
       coalesce((SELECT status FROM last), '(なし)'),
       CASE WHEN (SELECT status FROM last) = 'sent' THEN 'OK: 実際に送信された'
            WHEN (SELECT status FROM last) = 'failed' THEN 'NG: 送信失敗。Function Logs を確認'
            ELSE 'NG: 想定外の値' END
UNION ALL
SELECT 4, '最新行の email_id',
       CASE WHEN (SELECT content->>'email_id' FROM last) IS NULL THEN '(NULL)' ELSE '(非NULL・値は伏せる)' END,
       CASE WHEN (SELECT content->>'email_id' FROM last) IS NOT NULL
            THEN 'OK: Resend の成功レスポンスを確認して記録している（E+1）'
            ELSE 'NG: 送信APIの成功を確認せずに ok を返している疑い' END
UNION ALL
SELECT 5, '最新行のパルス本文（3〜4行）',
       coalesce((SELECT content->'lines' FROM last)::text, '(なし)'),
       'OK なら「昨日: N件」「主な種別: schedule / 特記事項なし」「状態: 平常」の3行。4行目が出ていたら要調査'
UNION ALL
SELECT 6, '最新行の created_at',
       coalesce((SELECT created_at::text FROM last), '(なし)'),
       'INFO: 実行時刻と一致すること'
ORDER BY seq;
