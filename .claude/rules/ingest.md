---
paths: ["supabase/functions/ingest*/**", "supabase/migrations/*event*", "src/ingest/**"]
---

- 全取込はイベントエンベロープ（docs/spec/01）に正規化。下流にコネクタ固有の形を漏らさない
- event_id = hash(source, source_native_id)。CSVは hash(file_fingerprint, row_content)。UPSERTで冪等
- S0はcompany_id=nullで1回のみ取込。S2テーブルに本文カラムを作らない（allowlist: .claude/hooks/参照）
- occurred_at必須。期間データはperiod_start/end。ingested_atと混同しない
- レート制限はレジストリ（connector_limits）参照。ハードコード禁止。KOT禁止時間帯・Slack 1req/分・IG 200/時
- 取込失敗はstatusテーブルに記録し例外で落とさない。トークンをログ・イベントに出力しない
- カレンダーのタイトルは準本文として扱う: 機微カテゴリ検出時はS2相当に格下げし、本文・Finding・ログへのタイトル引用禁止（spec/10 第0段）
- 未接続データ源に依存する実装を縮退形なしで書かない（spec/10 縮退規律）
