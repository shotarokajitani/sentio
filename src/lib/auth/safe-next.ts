/**
 * ログイン後の戻り先を自サイト内のパスに限定する。
 *
 * フォームの hidden 値やクエリはそのまま信用できない。
 * `https://evil.example` や `//evil.example` を通すと、
 * 認証直後の利用者を外部サイトへ運ぶオープンリダイレクトになる。
 */
export const DEFAULT_NEXT = "/connect";

export function safeNext(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_NEXT;

  // プロトコル相対（//host）とバックスラッシュ表記（/\host）は外部へ出る
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
    return DEFAULT_NEXT;
  }

  return raw;
}
