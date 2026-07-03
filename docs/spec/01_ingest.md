# 01 Ingest層（収集・正規化）

## イベントエンベロープ（下流が知る唯一の形式）

event_id（source＋固有IDのハッシュ。冪等性の要）/ company_id（S0はnull＝共有タイムライン）/
occurred_at / period_start・period_end（期間データ用、任意）/ ingested_at / source（コネクタ＋スキーマ版）/
event_type / actor_ref / entity_refs[] / metrics(jsonb) / sensitivity

## event_type 8分類

transaction（会計仕訳・受注・入出金）/ communication（発言時刻・返信間隔等メタのみ）/
schedule（予定）/ attendance（打刻）/ web（GA4・GSC・GBP・Instagram）/
external（S0公開データ: e-Stat・日銀・gBizINFO・jGrants・競合差分・天候・人流）/
monitor（死活・SSL・速度・コネクタ鮮度）/ dialogue（経営者の返答・質問、従業員1タップ回答）

## sensitivity 4区分

S0 公開（共有タイムライン・1回だけ取込）/ S1 業務 / S2 個人行動メタ（本文フィールドは構造上存在しない）/
S3 本人対話（本文可。由来は本人発話のみ）

## コネクタ4区分（確定カタログ）

A 顧客OAuth: Googleカレンダー（遡及◎）・freee（遡及◎、→MF/弥生Next）・GA4/GSC（遡及◎）・
Slack/Chatwork（前向きのみ。Slack遡及はMarketplace承認後）・Instagram（前向き。Meta審査要）・
GBP（要利用申請）・Gmailメタデータ（フェーズ2=CASA後）・取引記録型（EC/POS/販売管理: スマレジAPI可、Square等要確認）・勤怠
B Sentio自動収集: e-Stat（小地域拡張）・日銀・Places・為替・RSS・人流・社人研・gBizINFO・jGrants・天候・競合サイト差分・稼働監視
C オンボーダーCSV/Excel投入（Airレジ・弥生・Meta広告・HubSpot・顧客台帳。列マッピングはClaude補助）
D 従業員接点（1タップ回答のみ。唯一の入力）

## 規律

- 冪等バックフィル: 遡及も日次も同一経路。CSVはファイル指紋＋行内容ハッシュでevent_id生成
- 第三者個人情報の最小化: イベントは内部エンティティIDのみ。氏名等はentities台帳が最小限保持
- レート制限レジストリ: コネクタごとの制約（KOT禁止時間帯・Slack 1req/分・Instagram 200/時等）を宣言的に一元管理
- 取込失敗はオンボーディングを妨げない（status記録→再試行。crawl.status方式の一般化）
- トークン型フィールドをどのテーブルにも持たせない（保管はVaultのみ→05）

## エコシステム受け側（予約・v1.5）

Lauda・Motus・Pagusは区分Aの特殊形（自社プロダクト間連携）。Laudaは新実装でレビュー・返信・Score・履行イベントを
本エンベロープ互換（web/external系・S1/S2区分）で出力することを確約済み（2026-07-02 Laudaスレッド）。
Sentio側はsource='lauda'等のイベントを追加開発なしで受けられることをスキーマ上保証する（event_typeとsensitivityの列挙に収まること）。
