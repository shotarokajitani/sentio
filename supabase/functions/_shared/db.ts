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

/**
 * 複数行の読み取り。`error` があれば throw し、無ければ `data` を返す（**0件は空配列**）。
 *
 * 引数の型を `data: T | null` にしてあるのは、PostgREST の応答が
 * `{ data: Row[]; error: null } | { data: null; error: PostgrestError }` の**合併**だからである。
 * `data: T` のまま受けると `T` が `Row[] | null` に推論され、**全呼び出し元で
 * 「possibly null」の型エラー**になる（2026-08-19 の CI `deno check` で28件発生）。
 * `T | null` から null を落として推論させることで、戻り値が `Row[]` に定まる。
 *
 * **0件の可能性がある単一行の取得には使わない。** `maybeSingle()` / `single()` は
 * `mustMaybe()` を使うこと（そちらは `null` を返り値の型に残す）。
 */
export async function mustData<T>(
  query: PromiseLike<{ data: T | null; error: PostgrestErrorLike | null }>,
  context: string,
): Promise<T> {
  const { data, error } = await query;
  if (error) throw new DbError(context, error.message, error.code);
  // 成功時に data が null になるのは maybeSingle / single の 0件だけで、
  // それらは mustMaybe を使う契約にしてある
  return data as T;
}

/**
 * 単一行の読み取り（`maybeSingle()` / `single()`）。**0件は `null` をそのまま返す。**
 *
 * `mustData` と分けているのは、**0件を型から消さないため**である（S-2-3）。
 * 0件とエラーが区別できることが要件なので、`null` を返り値の型に残して
 * 呼び出し元に分岐を強制する。
 */
export async function mustMaybe<T>(
  query: PromiseLike<{ data: T | null; error: PostgrestErrorLike | null }>,
  context: string,
): Promise<T | null> {
  const { data, error } = await query;
  if (error) throw new DbError(context, error.message, error.code);
  return data;
}

/**
 * 件数だけを取る（`select("*", { count: "exact", head: true })`）。
 *
 * `head: true` は `data` を返さないので `mustData` では受けられない。
 * 「count を取るときだけ生の分割代入に戻る」を作ると、そこが検査の穴になるため、
 * **正規形をもう1つ増やす**（`takeError` を足したのと同じ考え方）。
 */
export async function mustCount(
  query: PromiseLike<PostgrestResultLike<unknown> & { count: number | null }>,
  context: string,
): Promise<number> {
  const { count, error } = await query;
  if (error) throw new DbError(context, error.message, error.code);
  return count ?? 0;
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
