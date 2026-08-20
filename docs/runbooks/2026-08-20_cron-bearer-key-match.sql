-- 2026-08-20 / 停止点(2)「静的一致」用の受け渡しSQL（スライスS・merge 前に実施）
--
-- 目的:
--   cron ジョブが Edge Function に送る Authorization ヘッダの値と、
--   プロジェクトの現行 service_role キーが**同じ値か**を、
--   **関数を1回も呼ばずに**確かめる。
--
-- なぜ merge 前に要るのか:
--   このスライスで deploy 対象17本すべてから `--no-verify-jwt` を外す。
--   以後は**ゲートウェイ層でも** JWT 検証が入るため、不一致のままデプロイすると
--   唯一稼働している `sync-connections` が毎日 401 で止まる。
--   しかも `net.http_post` は非同期なので `cron.job_run_details` は succeeded のまま
--   （＝止まっていることがどこにも出ない）。事前確認は落とせない。
--
-- 実行場所: Supabase ダッシュボードの SQL Editor（ロールは postgres）。
--           read_vault_secret_by_name は service_role 限定だが、
--           関数所有者である postgres は EXECUTE を保持しているため実行できる。
-- 副作用:   無し。SELECT のみ。invoke も UPDATE も行わない。
--
-- ============================================================================
-- ★★ 結果を貼り戻す前に必ず読むこと ★★
--
--   Q1 の `command_raw` 列には、cron が送る Bearer の値が**平文で入っている
--   可能性がある**（00018 の GUC 版や、手作業で登録されたジョブが残っている場合）。
--
--   会話・Issue・PR・ドキュメントへ貼り戻すのは **`command_redacted` 列だけ**。
--   `command_raw` は画面で目視するだけにして、コピーしない。
--   Q1 は平文トークンを検出したら自動で
--       <REDACTED:len=NNN,tail=XXXX>
--   に置換した列を作る（len = 文字数 / tail = 末尾4文字）。手で消し忘れる経路を作らない。
--
--   Q2・Q3 はキーそのものを出さない。長さ・末尾4文字・SHA-256 だけを出す。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Q0. PostgreSQL のバージョン（S-1 の停止点0。ついでにここで採っておく）
-- ---------------------------------------------------------------------------
select version() as pg_version,
       current_setting('server_version_num')::int as server_version_num;

-- ---------------------------------------------------------------------------
-- Q1. cron ジョブの一覧。トークンがリテラルか Vault 参照かをここで判定する
-- ---------------------------------------------------------------------------
select
  j.jobid,
  j.jobname,
  j.schedule,
  j.active,
  case
    when t.token is not null then 'リテラル埋め込み（→ Q3 へ）'
    when j.command like '%read_vault_secret_by_name%' then 'Vault 参照（→ Q2 へ）'
    else '判定不能（本文を目視すること）'
  end as token_kind,
  case
    when t.token is null then j.command
    else replace(
           j.command,
           t.token,
           '<REDACTED:len=' || length(t.token) || ',tail=' || right(t.token, 4) || '>'
         )
  end as command_redacted,
  j.command as command_raw   -- ← 目視専用。貼り戻さない
from cron.job j
left join lateral (
  -- `Bearer ' || public.read_vault_secret_by_name(...)` の形は、直後が `'` なので一致しない。
  -- 一致するのは `Bearer <生トークン>` の形だけ
  select (regexp_match(j.command, 'Bearer\s+([A-Za-z0-9._~+/=-]{20,})'))[1] as token
) t on true
order by j.jobid;

-- ---------------------------------------------------------------------------
-- Q2. 【Vault 参照だった場合】Vault 側の値の指紋を出す（値そのものは出さない）
-- ---------------------------------------------------------------------------
select
  length(v)                                     as key_len,
  right(v, 4)                                   as key_tail,
  left(v, 3)                                    as key_prefix,   -- 'eyJ' ならレガシーJWT形式
  encode(sha256(convert_to(v, 'utf8')), 'hex')  as key_sha256
from (select public.read_vault_secret_by_name('sentio_service_role_key') as v) s;

-- ---------------------------------------------------------------------------
-- Q3. 【リテラル埋め込みだった場合】埋め込まれている値の指紋を出す
-- ---------------------------------------------------------------------------
select
  j.jobid,
  j.jobname,
  length(t.token)                                     as key_len,
  right(t.token, 4)                                   as key_tail,
  left(t.token, 3)                                    as key_prefix,
  encode(sha256(convert_to(t.token, 'utf8')), 'hex')  as key_sha256
from cron.job j
join lateral (
  select (regexp_match(j.command, 'Bearer\s+([A-Za-z0-9._~+/=-]{20,})'))[1] as token
) t on t.token is not null
order by j.jobid;

-- ---------------------------------------------------------------------------
-- 突き合わせ相手（現行の service_role キー）の指紋の採り方、および
-- リテラル / Vault それぞれの直し方は
--   docs/secrets-runbook.md 「service_role キーの保管先は3箇所ある」
-- に書いてある。**この SQL だけでは判定は完了しない。**
-- ---------------------------------------------------------------------------
