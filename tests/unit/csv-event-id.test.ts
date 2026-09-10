/**
 * CSV の `event_id` は内容だけで決まる（発注 ①-5）。
 *
 * ## 直す前に何が起きていたか
 *
 * 旧規則は `sha256("csv:" + company_id + ":" + file_name + ":" + 行の生テキスト)`。
 * **ファイル名が鍵に入っていた。** 同じ明細を `2026-08.csv` と `8月.csv` の2回で
 * 取り込むと全行が二重に入り、**入出金も残高も倍になる。**
 *
 * `events` は upsert（`onConflict: event_id`）なので、鍵が同じなら重ならない。
 * **鍵の作り方だけが問題だった。**
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { csvEventId, normalizeDescription, type CsvRowKey } from "@/lib/csv/event-id";

const KEY: CsvRowKey = {
  companyId: "11111111-1111-1111-1111-111111111111",
  date: "2026-09-01",
  direction: "credit",
  amount: 396000,
  description: "カ）サンプル ショウジ",
  balance: 1234567,
};

describe("同じ内容なら同じ event_id になる", () => {
  it("**ファイル名は鍵に入らない**（別名で入れ直しても増えない）", () => {
    // 旧規則ではここが別の値になり、全行が二重に入っていた
    expect(csvEventId(KEY)).toBe(csvEventId({ ...KEY }));
  });

  it("**陰性**: 摘要の全角・半角の違いを同一と読む", () => {
    const half = csvEventId({ ...KEY, description: "ﾃﾞﾝｷ ﾀﾞｲ" });
    const full = csvEventId({ ...KEY, description: "デンキ　ダイ" });
    expect(half).toBe(full);
  });

  it("**陰性**: 空白の有無・大文字小文字の違いも同一と読む", () => {
    expect(csvEventId({ ...KEY, description: "ａｂｃ 商事" })).toBe(
      csvEventId({ ...KEY, description: "ABC商事" }),
    );
  });
});

describe("別の取引は別の event_id になる", () => {
  const cases: [string, Partial<CsvRowKey>][] = [
    ["会社が違う", { companyId: "22222222-2222-2222-2222-222222222222" }],
    ["日付が違う", { date: "2026-09-02" }],
    ["入出金の向きが違う", { direction: "debit" }],
    ["金額が違う", { amount: 396001 }],
    ["摘要が違う", { description: "別の取引" }],
    ["残高が違う", { balance: 1234568 }],
  ];

  for (const [label, over] of cases) {
    it(`**陰性**: ${label}なら別の鍵になる（潰しすぎない）`, () => {
      expect(csvEventId({ ...KEY, ...over })).not.toBe(csvEventId(KEY));
    });
  }

  it("**陰性**: 残高が無い形式と、残高0の行を混同しない", () => {
    expect(csvEventId({ ...KEY, balance: null })).not.toBe(csvEventId({ ...KEY, balance: 0 }));
  });
});

describe("摘要の正規化", () => {
  it("濁点は1文字に合成する（`ｶ` + `ﾞ` を `ガ` と同じにする）", () => {
    expect(normalizeDescription("ｶﾞｽ")).toBe("ガス");
    expect(normalizeDescription("ﾊﾟﾝ")).toBe("パン");
  });

  it("空白は全角・半角・タブのどれも除く", () => {
    expect(normalizeDescription("ア　イ\tウ エ")).toBe("アイウエ");
  });

  it("**陰性**: 記号と数字は残す（潰すと別の取引が同一になる）", () => {
    expect(normalizeDescription("A-1")).not.toBe(normalizeDescription("A-2"));
    expect(normalizeDescription("振込#01")).toContain("#01");
  });

  it("空文字を入れても落ちない", () => {
    expect(normalizeDescription("")).toBe("");
  });
});

describe("取り込み経路が新しい規則を使っている", () => {
  const route = readFileSync(
    path.resolve(__dirname, "../../src/app/api/csv/ingest/route.ts"),
    "utf8",
  );

  it("`csvEventId` を呼んでいる", () => {
    expect(route).toContain("csvEventId({");
  });

  it("**陰性**: ファイル名も行の生テキストも鍵に使っていない", () => {
    expect(route).not.toContain("fileFingerprint");
    expect(route).not.toContain('cols.join(",")');
    // 旧規則の直書きが残っていないこと
    expect(route).not.toContain("createHash");
  });

  it("重複として除いた件数を応答に出す（**黙って消さない**）", () => {
    expect(route).toContain("duplicates");
    expect(route).toContain("重複していた");
  });
});

describe("SQL 側の正規化が TypeScript と同じ順序で書かれている", () => {
  const migration = readFileSync(
    path.resolve(__dirname, "../../supabase/migrations/00045_csv_event_id_recompute.sql"),
    "utf8",
  );

  it("濁点の合成を単体の置換より先に行う（順序が逆だと合成できない）", () => {
    const voiced = migration.indexOf("'ｶﾞ','ガ'");
    const single = migration.indexOf("'ｱｲｳｴｵｶｷｸｹｺ");
    expect(voiced).toBeGreaterThan(-1);
    expect(single).toBeGreaterThan(-1);
    expect(voiced).toBeLessThan(single);
  });

  it("残高が無い行は空文字にする（`null` と書き分けない）", () => {
    expect(migration).toContain("WHEN p_balance IS NULL THEN ''");
  });

  it("`digest` を extensions スキーマで修飾している（本番の実測に合わせる）", () => {
    expect(migration).toContain("extensions.digest(");
  });

  it("数値の文字列化が JS と揃っている（`to_char` は末尾のピリオドを残す）", () => {
    // `to_char(396000, 'FM999999999999990.999999')` は `396000.` を返す。
    // **`FM` は末尾のゼロを削るが、ピリオドは残る**（2026-09-10 の本番実測）
    expect(migration).toContain("csv_number_text");
    expect(migration).toContain("rtrim(rtrim(trim(to_char(v, 'FM999999999999990.999999')), '0'), '.')");
    // 自表検証が3つの形を実DBで確かめる
    expect(migration).toContain("csv_number_text(396000) <> '396000'");
    expect(migration).toContain("csv_number_text(396000.5) <> '396000.5'");
  });

  it("古い1行を残す（最初に取り込んだ事実を残す）", () => {
    // **`events` に `created_at` は無い**（2026-09-10 の本番実測）。
    // 取り込んだ時刻は `ingested_at` である
    expect(migration).toContain("ORDER BY ingested_at ASC NULLS LAST");
  });
});
