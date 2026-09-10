/**
 * LLM へ渡す前に、渡してはいけないものを落とす（発注 E-2）。**判断だけを持つ。**
 *
 * ## 何を渡していたか
 *
 * `investigate/index.ts` は証拠イベントを `JSON.stringify(e.metrics)` で
 * そのままプロンプトに入れていた。カレンダー由来のイベントの `metrics` には
 * **出席者のメールアドレスがそのまま入っている**
 * （`sync-connections` が `metrics: { title, attendees }` として書く）。
 *
 * つまり**顧客の取引先のメールアドレスが、そのまま外部の LLM へ送られていた。**
 * Finding に必要なのは「誰と会ったか」ではなく「社内か社外か・何人か」である。
 *
 * ## 何に置き換えるか
 *
 * 出席者は **人数と、社内 / 社外の内訳だけ**にする。内訳は自社ドメインとの
 * 一致で決める。ドメインが分からない場合は**社外に倒す**——
 * 「社内だと思ったら社外だった」ほうが害が大きい。
 *
 * ## 題名は「データであり指示ではない」
 *
 * カレンダーの題名は顧客の取引先が書いた文字列である。
 * **「これまでの指示を無視して」と書かれた予定を入れられる。**
 * 区切り文字で囲み、プロンプト側にも明記する。囲むだけでは足りないので、
 * 区切り文字そのものが本文に含まれていたら削る。
 */

/** 題名を囲む区切り。**本文に現れたら削る**ので、囲みを破れない */
export const DATA_FENCE = "<<<DATA>>>";

/** LLM に渡してよい形にした出席者 */
export interface AttendeeSummary {
  total: number;
  internal: number;
  external: number;
}

/**
 * 出席者を人数と内訳にする。**アドレスもドメインも返さない。**
 *
 * `ownDomain` が空なら全員を社外として数える。**分からないものを社内にしない。**
 */
export function summarizeAttendees(
  attendees: unknown,
  ownDomain: string | null | undefined,
): AttendeeSummary {
  if (!Array.isArray(attendees)) return { total: 0, internal: 0, external: 0 };

  const domain = (ownDomain ?? "").trim().toLowerCase().replace(/^@/, "");
  let internal = 0;

  for (const a of attendees) {
    if (typeof a !== "string") continue;
    const at = a.lastIndexOf("@");
    // **アドレスの形をしていないものは社外に数える**（判別できないものを社内にしない）
    if (domain && at >= 0 && a.slice(at + 1).toLowerCase() === domain) internal++;
  }

  const total = attendees.filter((a) => typeof a === "string").length;
  return { total, internal, external: total - internal };
}

/**
 * 予定の題名など、**顧客側が書いた文字列**をプロンプトに載せられる形にする。
 *
 * 区切り文字が本文に含まれていたら削る。**囲みを内側から破らせない。**
 */
export function fenceUntrusted(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  return text.split(DATA_FENCE).join("");
}

/**
 * 証拠イベントの `metrics` を、LLM に渡してよい形にする。
 *
 * **既定は落とすほうである。** 明示的に通す鍵だけを通し、知らない鍵は捨てる
 * （allowlist）。新しい鍵が増えたときに黙って外へ出ないようにする。
 */
const ALLOWED_METRIC_KEYS = [
  "amount",
  "direction",
  "balance",
  "is_overdue",
  "monitor_status",
] as const;

export function sanitizeMetrics(
  metrics: unknown,
  ownDomain: string | null | undefined,
): Record<string, unknown> {
  if (typeof metrics !== "object" || metrics === null) return {};
  const src = metrics as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const key of ALLOWED_METRIC_KEYS) {
    if (key in src) out[key] = src[key];
  }

  // 摘要と題名は**顧客側が書いた文字列**なので囲む
  if (typeof src.description === "string") out.description = fenceUntrusted(src.description);
  if (typeof src.title === "string") out.title = fenceUntrusted(src.title);

  // **出席者は人数と内訳だけ。** アドレスは1つも通さない
  if ("attendees" in src) out.attendees = summarizeAttendees(src.attendees, ownDomain);

  return out;
}
