/**
 * DBエラーを握りつぶさない共通経路（契約 S-2-1 〜 S-2-5）。
 *
 * 2026-08-19 以前、Edge Function は `const { data } = await supabase...` の形で
 * `error` を受け取らず、存在しない列を読んでも `(no baselines)` のような既定値を返して
 * **HTTP 200 で正常終了**していた。State層が実スキーマに対して一度も動いていない事実が、
 * この「静かに空」の裏で緑のまま素通りしていた。
 *
 * 規約は1本に単純化してある:
 *   **Supabase の `.from()` は必ず `mustData()` / `mustOk()` で包む。**
 * `scripts/check-db-error-handling.ts` がこれを機械的に検査する（S-2-4）。
 *
 * **0件は正常系である。** 空配列も `maybeSingle()` の null も、`error` が無ければ
 * そのまま通す。0件とエラーを区別できること自体が S-2-3 の要件なので、
 * ここで 0件を例外に格上げしてはいけない。
 */

export interface PostgrestErrorLike {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
}

export interface PostgrestResultLike<T> {
  data: T;
  error: PostgrestErrorLike | null;
}

/**
 * DBアクセスの失敗。
 *
 * `context` に「どの関数のどのクエリか」を入れる。5xx として返したとき、
 * 呼び出し側が原因の場所を特定できる状態を保つため。
 * **秘密は載せない**（S-7-4）。載せるのは context / message / code だけ。
 */
export class DbError extends Error {
  readonly context: string;
  readonly code?: string;

  constructor(context: string, message: string, code?: string) {
    super(code ? `${context}: ${message} (${code})` : `${context}: ${message}`);
    this.name = "DbError";
    this.context = context;
    this.code = code;
  }
}

export function isDbError(e: unknown): e is DbError {
  return e instanceof DbError;
}

/**
 * catch 節から返す 5xx。DBエラーは**握りつぶさず失敗として返す**（S-2-2）。
 *
 * 0件は正常系として 200 で返すので、ここに来るのは常に異常系である。
 * `db_context` を載せるのは、どのクエリで落ちたかを応答から特定できるようにするため
 * （`(no baselines)` を 200 で返していた頃は、どこが壊れているか応答から分からなかった）。
 */
export function errorResponse(error: unknown, extraHeaders: Record<string, string> = {}): Response {
  const body: Record<string, unknown> = { error: (error as Error).message };

  if (isDbError(error)) {
    body.db_context = error.context;
    if (error.code) body.db_code = error.code;
  }

  return new Response(JSON.stringify(body), {
    status: 500,
    headers: { ...extraHeaders, "Content-Type": "application/json" },
  });
}

/** 読み取り。`error` があれば throw し、無ければ `data` をそのまま返す（0件を含む）。 */
export async function mustData<T>(
  query: PromiseLike<PostgrestResultLike<T>>,
  context: string,
): Promise<T> {
  const { data, error } = await query;
  if (error) throw new DbError(context, error.message, error.code);
  return data;
}

/** 書き込み。`error` があれば throw する。戻り値は使わない。 */
export async function mustOk(
  query: PromiseLike<PostgrestResultLike<unknown>>,
  context: string,
): Promise<void> {
  const { error } = await query;
  if (error) throw new DbError(context, error.message, error.code);
}

/**
 * throw せずに失敗を**値として**受け取る。失敗なら `DbError`、成功なら `null`。
 *
 * throw が正しくない場所のためにある。たとえば `_shared/token-refresh.ts` は
 * 「リフレッシュに失敗した理由」を呼び出し元に返し、呼び出し元が
 * `status = reauth_required` に落とす。ここで throw すると、その分岐ごと消える。
 *
 * **これは検査の抜け道ではない。** 除外リストを作る代わりに、
 * 「エラーを必ず受け取る」形を1つ増やしている。受け取ったあとに無視すれば、
 * それは普通のコードレビューで見える形の握りつぶしになる
 * （`const err = await takeError(...)` と書いて `err` を使わなければ lint が拾う）。
 */
export async function takeError(
  query: PromiseLike<PostgrestResultLike<unknown>>,
  context: string,
): Promise<DbError | null> {
  const { error } = await query;
  return error ? new DbError(context, error.message, error.code) : null;
}
