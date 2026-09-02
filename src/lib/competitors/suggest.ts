/**
 * 競合の推定を1度だけ起こす（`/api/competitors/suggest` の呼び出し口）。
 *
 * **なぜ必要だったか。**
 * 2026-09-02 の監査で、`type: "competitor"` の entity を書いているのは
 * `/api/competitors/suggest` **だけ**で、そこに**呼び出し元が1つも無い**ことが分かった
 * （`git log -S` で探しても存在した形跡が無く、`/api/analyze-url` と同じ
 * 2026-07-23 のコミットで生まれている）。`day0` はそれを**読む**側なので、
 * **Day0 レポートの競合の節は一度も実データで埋まったことがなかった。**
 *
 * コンポーネントではなくモジュールに置いてあるのは、
 * DOM を起こさずに「叩かない条件」を試験できるようにするためである
 * （`lib/connections/disconnect.ts` / `lib/csv/analyze.ts` と同じ形）。
 */

/** 競合推定 API の場所。呼び出し元の実在検査（`check:endpoint-callers`）はこの文字列を見る */
export const COMPETITORS_SUGGEST_ENDPOINT = "/api/competitors/suggest";

export type SuggestOutcome =
  /** 推定して entities に入れた（`already` のときは既に持っていたので何もしていない） */
  | { ok: true; created: number; already?: true }
  /** 自社サイトのURLが無いので**叩いていない** */
  | { ok: false; reason: "no_site_url" }
  /** それ以外の失敗。画面には出さない（この機能は利用者の操作ではない） */
  | { ok: false; reason: "failed"; status: number | null };

/**
 * 自社サイトのURLがあるときだけ、競合の推定を依頼する。
 *
 * **URL が無ければネットワークに出ない。** 登録時の入力は任意項目であり、
 * 空欄のまま使い続ける利用者がいる。そのたびに 400 を叩きに行く理由が無い。
 *
 * 会社名も業種も送らない。**登録時に聞いているのは URL 1項目だけ**である
 * （入力を増やさないための線引き・2026-09-02 梶谷さん判断）。
 * サーバ側は会社名かURLのどちらかがあればよい形にしてある。
 */
export async function requestCompetitorSuggestion(input: {
  siteUrl: string | null;
  fetchImpl?: typeof fetch;
}): Promise<SuggestOutcome> {
  const url = input.siteUrl?.trim();
  if (!url) return { ok: false, reason: "no_site_url" };

  const doFetch = input.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch(COMPETITORS_SUGGEST_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
  } catch {
    return { ok: false, reason: "failed", status: null };
  }

  if (!res.ok) return { ok: false, reason: "failed", status: res.status };

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if ((body as { status?: unknown } | null)?.status === "already") {
    return { ok: true, created: 0, already: true };
  }

  const created = (body as { count?: unknown } | null)?.count;
  return { ok: true, created: typeof created === "number" ? created : 0 };
}
