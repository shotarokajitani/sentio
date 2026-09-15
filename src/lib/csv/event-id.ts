import { createHash } from "node:crypto";

/**
 * CSV 1行の `event_id` を決める（発注 ①-5）。**内容だけで決まる。**
 *
 * ## 直す前に何が起きていたか
 *
 * 旧規則は `sha256("csv:" + company_id + ":" + file_name + ":" + 行の生テキスト)` だった。
 * **ファイル名が鍵に入っている。**
 *
 *   - 同じ明細を `2026-08.csv` と `8月.csv` の2回で取り込むと、**全行が二重に入る**
 *   - 列の並びを変えただけの再出力でも `cols.join(",")` が変わるので二重に入る
 *   - 銀行の再ダウンロードで書式が揺れても二重になる
 *
 * **顧客は「入れ直した」だけのつもりで、入出金も残高も倍になる。**
 * `events` は upsert（`onConflict: event_id`）なので、鍵が同じなら重ならない——
 * つまり**鍵の作り方だけが問題**だった。
 *
 * ## 新しい規則
 *
 *   sha256("csv:" + company_id + ":" + 日付 + ":" + direction + ":" + amount
 *          + ":" + 正規化した摘要 + ":" + 残高)
 *
 * **ファイル名も行の生テキストも入れない。** 同じ取引を指す値だけで決める。
 *
 * 残高が無い形式は**空文字で固定**する。`null` や `"null"` と書き分けると、
 * 実装を変えたときに鍵が変わり、過去の行と重ならなくなる。
 */

/** U+2212 MINUS SIGN。ソースに見分けにくい文字を直接書かない */
const MINUS_SIGN = String.fromCharCode(0x2212);

/**
 * 同じ Shift_JIS のバイトから来る対（#135 の検収で決定）。**左を右に寄せる。**
 *
 * - 0x8160 波ダッシュ: U+301C（iconv）→ '~'（U+FF5E は全角→半角で既に '~' になる）
 * - 0x8161 双柱: U+2225（CP932）→ U+2016（iconv）
 * - 0x8191 セント: U+FFE0（CP932）→ U+00A2（iconv）
 * - 0x8192 ポンド: U+FFE1（CP932）→ U+00A3（iconv）
 * - 0x81CA 否定: U+FFE2（CP932）→ U+00AC（iconv）
 *
 * 見分けにくい文字をソースに直接書かないので、コードポイントで作る
 */
const SJIS_VARIANT_PAIRS: Array<[string, string]> = [
  [String.fromCharCode(0x301c), "~"],
  [String.fromCharCode(0x2225), String.fromCharCode(0x2016)],
  [String.fromCharCode(0xffe0), String.fromCharCode(0x00a2)],
  [String.fromCharCode(0xffe1), String.fromCharCode(0x00a3)],
  [String.fromCharCode(0xffe2), String.fromCharCode(0x00ac)],
];

/** 半角カナ → 全角カナ（濁点なし） */
const KANA_BASE: Record<string, string> = {
  ｱ: "ア",
  ｲ: "イ",
  ｳ: "ウ",
  ｴ: "エ",
  ｵ: "オ",
  ｶ: "カ",
  ｷ: "キ",
  ｸ: "ク",
  ｹ: "ケ",
  ｺ: "コ",
  ｻ: "サ",
  ｼ: "シ",
  ｽ: "ス",
  ｾ: "セ",
  ｿ: "ソ",
  ﾀ: "タ",
  ﾁ: "チ",
  ﾂ: "ツ",
  ﾃ: "テ",
  ﾄ: "ト",
  ﾅ: "ナ",
  ﾆ: "ニ",
  ﾇ: "ヌ",
  ﾈ: "ネ",
  ﾉ: "ノ",
  ﾊ: "ハ",
  ﾋ: "ヒ",
  ﾌ: "フ",
  ﾍ: "ヘ",
  ﾎ: "ホ",
  ﾏ: "マ",
  ﾐ: "ミ",
  ﾑ: "ム",
  ﾒ: "メ",
  ﾓ: "モ",
  ﾔ: "ヤ",
  ﾕ: "ユ",
  ﾖ: "ヨ",
  ﾗ: "ラ",
  ﾘ: "リ",
  ﾙ: "ル",
  ﾚ: "レ",
  ﾛ: "ロ",
  ﾜ: "ワ",
  ｦ: "ヲ",
  ﾝ: "ン",
  ｧ: "ァ",
  ｨ: "ィ",
  ｩ: "ゥ",
  ｪ: "ェ",
  ｫ: "ォ",
  ｬ: "ャ",
  ｭ: "ュ",
  ｮ: "ョ",
  ｯ: "ッ",
  ｰ: "ー",
  "｢": "「",
  "｣": "」",
  "､": "、",
  "｡": "。",
  "･": "・",
};

/** 濁点が付く半角カナ */
const KANA_VOICED: Record<string, string> = {
  ｶ: "ガ",
  ｷ: "ギ",
  ｸ: "グ",
  ｹ: "ゲ",
  ｺ: "ゴ",
  ｻ: "ザ",
  ｼ: "ジ",
  ｽ: "ズ",
  ｾ: "ゼ",
  ｿ: "ゾ",
  ﾀ: "ダ",
  ﾁ: "ヂ",
  ﾂ: "ヅ",
  ﾃ: "デ",
  ﾄ: "ド",
  ﾊ: "バ",
  ﾋ: "ビ",
  ﾌ: "ブ",
  ﾍ: "ベ",
  ﾎ: "ボ",
  ｳ: "ヴ",
};

/** 半濁点が付く半角カナ */
const KANA_SEMI_VOICED: Record<string, string> = {
  ﾊ: "パ",
  ﾋ: "ピ",
  ﾌ: "プ",
  ﾍ: "ペ",
  ﾎ: "ポ",
};

/**
 * 摘要を正規化する。**同じ取引を同じ文字列にするのが目的。**
 *
 * 銀行の再出力は、同じ取引の摘要を全角と半角で行き来する。
 * **見た目が違うだけで別の取引として入る**のを止める。
 *
 * ここを緩めすぎると**別の取引が同一と判定されて片方が消える**ので、
 * 除くのは空白だけにしてある。記号も数字も残す。
 *
 * 半角カナは全角へ寄せる。**向きが逆だと、濁点が分離した2文字（`ｶ` + `ﾞ`）と
 * 1文字（`ガ`）が別物のまま残る。**
 */
export function normalizeDescription(raw: string): string {
  // 1. 全角の英数記号を半角へ（U+FF01〜U+FF5E が ASCII 0x21〜0x7E に対応する）
  let s = raw.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.replace(/　/g, " ");

  // 1-2. **マイナス記号（U+2212）をハイフン（U+002D）に寄せる**（2026-09-13 の点検・PR-3 の 22b）。
  //
  // 同じ Shift_JIS の CSV でも、読み方で 0x817C の割り当てが分かれる。
  // iconv の SHIFT_JIS は U+2212（−）に、ブラウザの TextDecoder（CP932）は U+FF0D（－）にする。
  // U+FF0D は上の全角→半角で既に `-` になるので、**U+2212 だけが別の鍵のまま残っていた。**
  // 2026-09-13 に同じ明細の19行が別の行として入った（検収側の再取り込みで実測）
  s = s.split(MINUS_SIGN).join("-");

  // 1-3. **同じ Shift_JIS のバイトが、読み方で別の文字になる対を寄せる**（#135 の検収で決定）。
  //      iconv（SHIFT_JIS）とブラウザ（CP932）で割り当てが分かれる。**同じバイトから来た文字どうし**
  //      なので、寄せても別の取引が同じにはならない。長音符・ダッシュ類は寄せない
  for (const [from, to] of SJIS_VARIANT_PAIRS) s = s.split(from).join(to);

  // 2. 半角カナを全角へ。**濁点・半濁点は次の文字を見てから合成する**
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];
    if (next === "ﾞ" && KANA_VOICED[ch]) {
      out += KANA_VOICED[ch];
      i++;
      continue;
    }
    if (next === "ﾟ" && KANA_SEMI_VOICED[ch]) {
      out += KANA_SEMI_VOICED[ch];
      i++;
      continue;
    }
    out += KANA_BASE[ch] ?? ch;
  }

  // 3. 空白をすべて除去 → 4. 大文字化
  return out.replace(/\s+/g, "").toUpperCase();
}

export interface CsvRowKey {
  companyId: string;
  /** `YYYY-MM-DD` に正規化済みの日付 */
  date: string;
  direction: "credit" | "debit" | "unknown";
  /** 符号を付ける前の絶対値 */
  amount: number;
  description: string;
  /** 残高欄が無い形式は `null`。**鍵の中では空文字に固定する** */
  balance: number | null;
}

/**
 * `event_id` を組む。**ファイル名も行の生テキストも入れない。**
 *
 * 同じ内容を別名で取り込んでも、列の並びが変わっても、同じ値になる。
 */
export function csvEventId(key: CsvRowKey): string {
  const parts = [
    "csv",
    key.companyId,
    key.date,
    key.direction,
    String(key.amount),
    normalizeDescription(key.description),
    // **無い残高を "null" と書かない。** 実装を変えたときに鍵が変わる
    key.balance === null ? "" : String(key.balance),
  ];
  return createHash("sha256").update(parts.join(":")).digest("hex");
}
