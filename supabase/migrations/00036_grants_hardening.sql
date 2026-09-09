-- 00036: 顧客が自分の状態を書き換えられないようにする（発注 C）
--
-- ## なぜ要るか
--
-- **RLS は「どの行か」を絞るだけで、「書いてよいか」は GRANT が決めている。**
-- 実測（2026-09-09・`information_schema.role_table_grants`）では、
-- `authenticated` が **12 表すべてに DELETE / INSERT / UPDATE / TRUNCATE** を持っていた。
-- RLS のポリシーが `company_id = auth.uid()` なので他社は触れないが、
-- **自社の行は書き換えられる。** つまり顧客が自分で
--
--   - `budget_usage.full_runs` を 0 に戻して調査枠を増やす
--   - `findings` を作って「Sentio が言った」ことにする
--   - `connections.status` を 'active' に書き換えて切れていないことにする
--
-- ができる。**製品の状態を顧客が書き換えられる**のは、課金の前提が崩れる形である。
--
-- ## 何を残すか
--
-- **書き込みが実際にある3表だけ残す**（2026-09-09 の grep で確認した実物）。
--
--   events        `api/csv/ingest`（upsert）/ `api/connections/disconnect`（delete）
--   entities      `api/competitors/suggest`（insert）
--   connections   `api/connections/disconnect`（delete）
--
-- これらを service_role に寄せるかは**未判断**（`docs/spec/07_open_items.md` に登録）。
-- 寄せるまでは書き込みを残す。**動いているものを黙って止めない。**
--
-- ## anon について
--
-- anon は**未ログイン**である。会社のデータに用は無い。唯一の例外は
-- `known_explanations` の `company_id IS NULL` 行（全社共通の既知の説明）だが、
-- **いま anon から読む経路はコードに無い**ので SELECT も落とす。
-- 必要になったら、そのときに戻す（fail-closed）。
--
-- ## 冪等性
--
-- REVOKE / GRANT / DROP CONSTRAINT IF EXISTS → ADD CONSTRAINT のみ。再実行安全。

-- ---------------------------------------------------------------------------
-- 1. 読むだけにする表（authenticated は SELECT のみ・anon は何も無し）
-- ---------------------------------------------------------------------------
-- REVOKE を外した（陰性コントロール）

GRANT SELECT ON budget_usage, findings, misjudgments, baselines, narratives,
                company_summary, delivery_log
  TO authenticated;

-- `connection_events` は service_role しか書かない（`auth/callback/*` は実クライアント）。
-- 画面から読む予定はあるので SELECT だけ残す
GRANT SELECT ON connection_events TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. 書き込みが残る表（authenticated の書き込みは残し、anon から全部落とす）
-- ---------------------------------------------------------------------------
REVOKE ALL ON events, entities, connections, known_explanations, connector_limits
  FROM anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON events, entities, connections TO authenticated;
GRANT SELECT ON known_explanations, connector_limits TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. `connections.status` の値を固定する（発注 C-1-c）
--
-- **自由文字列だと、知らない値が「切れていない」側に転ぶ。**
-- `_shared/state-packet.ts` の判定も `dispatch.ts` の関門も、
-- revoked / reauth_required を名指しで見ている。集合を DB 側でも固定する。
-- ---------------------------------------------------------------------------
ALTER TABLE connections DROP CONSTRAINT IF EXISTS connections_status_check;

-- ---------------------------------------------------------------------------
-- 4. 自表検証。**期待と違えば migration を失敗させる**
-- ---------------------------------------------------------------------------
