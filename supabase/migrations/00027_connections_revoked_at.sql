-- 00027: connections.revoked_at — 連携が取り消されたと判別できた時刻
--
-- なぜ要るか（契約 docs/contracts/slice-disconnect.md の決定 D-4）:
--   プライバシーポリシー §6 は「Google アカウントの設定から連携を解除した場合、
--   トークンを直ちに破棄し、当該連携から取得したデータを30日以内に削除します」と
--   公開している。**30日の起点を持つ列が無いと、この約束は実装できない。**
--
--   `connections` の時刻列は `last_refresh` / `expires_at` の2つだけで、
--   どちらも「トークンがいつまで有効か」を表す。ここに解除の観測時刻を相乗りさせると
--   1つの列が2つの意味を持ち、片方の更新がもう片方を壊す。専用の列を足す。
--
-- なぜ status の CHECK 制約を足さないか:
--   `status` は `TEXT NOT NULL DEFAULT 'pending'` で CHECK 制約が無い（00007:10）。
--   `'revoked'` を足すのに migration は要らない。ここで CHECK を新設すると、
--   既存行に想定外の値があった場合に**この migration 自体が本番で落ちる**。
--   値の妥当性は書き込み側（token-refresh.ts）とテストで担保する。
--
-- なぜ索引を張らないか:
--   `revoked_at` を条件に引くのは30日削除（受入基準 D-3 系）だが、**D-3 は本スライスで
--   実装しない**（契約の停止点。`revoked` の実例を人間が確認するまで着手禁止）。
--   引く経路が無いうちに索引だけ置くと、消し忘れの余地を作る。D-3 の着手時に足す。
--
-- 冪等性: IF NOT EXISTS。CI は毎回 `supabase db reset` で全 migration を素通しする。
--
-- RLS: `connections` の RLS と `users_own_connections`（FOR ALL / company_id = auth.uid()）は
--   00007 で有効化済み。列の追加はポリシーの対象範囲を変えないので、追加のポリシーは要らない。
--
-- allowlist: `check:allowlist` の対象は `events` のみ（scripts/check-allowlist.ts の
--   EVENTS_ALLOWLIST）。`connections` への列追加は絶対規則「S2テーブルに本文型カラムを
--   追加しない」に抵触しない。そもそも TIMESTAMPTZ であって本文型でもない。

ALTER TABLE connections
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

COMMENT ON COLUMN connections.revoked_at IS
  'Google 側での取り消しを判別できた時刻。invalid_grant を観測したときだけ入る。'
  '再連携が成功したら NULL に戻す。30日削除（契約 D-3）の起点。';
