/**
 * Edge Function の呼び出し元判定（契約 S-2-9 / S-4-1 / S-4-3 / S-4-6）。
 *
 * **これは堅牢化ではなく、現に開いている穴の閉塞である。**
 * 2026-08-19 の本番実測で、`state-memory-packet` は **認証情報ゼロでも、不正な Bearer でも
 * HTTP 200** を返し、`recent_events` の実データ 824文字を含むパケットを応答した。
 * `company_id` はボディで受け取ったものをそのまま service_role クライアントへ渡していたため、
 * 関数URLを知っていれば任意の会社の状態が読めた。
 *
 * ゲートウェイの `verify_jwt` だけでは足りない。`verify_jwt` は JWT の**署名と期限しか見ない**。
 * anon キーは `NEXT_PUBLIC_` でブラウザに配る前提の**公開された正当なJWT**なので、
 * それを付ければ検証を通る。「JWTを持っているか」と「その会社の人か」は別問題である。
 *
 * 使い方（**DBに触る前に**呼ぶ。順序が要件である — S-2-9）:
 *
 *   const caller = await resolveCaller(req);
 *   if (!caller.ok) return caller.response;
 *   const body = await req.json();
 *   const scope = resolveCompanyId(caller.caller, body.company_id);
 *   if (!scope.ok) return scope.response;
 *   // ここで初めて DB を引く
 */

import { corsHeaders } from "./cors.ts";

export type CallerKind = "internal" | "user";

export interface ResolvedCaller {
  kind: CallerKind;
  /** user 経路のみ。JWT 由来の company_id */
  companyId: string | null;
}

export type CallerResult = { ok: true; caller: ResolvedCaller } | { ok: false; response: Response };

export interface ResolveCallerDeps {
  serviceRoleKey?: string;
  /** トークンからユーザーを解決する。既定は Supabase Auth の getUser */
  getUser?: (token: string) => Promise<{ id: string } | null>;
}

/**
 * 環境変数の読み取り。`Deno` を直接参照しないのは、このファイルが
 * vitest からも型検査されるため（`_shared/token-refresh.ts` と同じ作法）。
 */
type EnvReader = (key: string) => string | undefined;

const readEnv: EnvReader = (key) =>
  (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(key);

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * 401 は**どのケースで落ちたかを書かない**。
 * 「トークンが不正」と「呼び出し元として許可されていない」を撃ち分けると、
 * 攻撃側にどこまで正しかったかを教えることになる。
 */
function unauthorized(): Response {
  return jsonResponse(401, { error: "unauthorized" });
}

export function extractBearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

/**
 * 長さを先に見てから1文字ずつ比較する。
 * 早期 return で「何文字目まで合っていたか」が実行時間に出ないようにする。
 */
function secretEquals(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function defaultGetUser(token: string): Promise<{ id: string } | null> {
  const url = readEnv("SUPABASE_URL") ?? "";
  const anonKey = readEnv("SUPABASE_ANON_KEY") ?? "";
  if (!url || !anonKey) return null;

  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
  });
  if (!res.ok) return null;

  const user = (await res.json()) as { id?: string };
  return user.id ? { id: user.id } : null;
}

/**
 * 呼び出し元を判定する。**DBに触る前に呼ぶこと。**
 *
 * @param allowed 許可する呼び出し元。**既定は `internal` のみ**。
 *   2026-08-19 時点で Next.js から Edge Function を呼ぶ箇所は0件（`src/` 全走査）なので、
 *   17本すべて既定のままで足りる。user 経路が要る関数だけ宣言を広げる。
 */
export async function resolveCaller(
  req: Request,
  allowed: readonly CallerKind[] = ["internal"],
  deps: ResolveCallerDeps = {},
): Promise<CallerResult> {
  const token = extractBearer(req.headers.get("Authorization"));
  if (!token) return { ok: false, response: unauthorized() };

  const serviceRoleKey = deps.serviceRoleKey ?? readEnv("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (secretEquals(token, serviceRoleKey)) {
    if (!allowed.includes("internal")) return { ok: false, response: unauthorized() };
    return { ok: true, caller: { kind: "internal", companyId: null } };
  }

  // service_role でないトークンを user として解決できるかを見る。
  // anon キーはここで user を返さないので 401 に落ちる
  if (!allowed.includes("user")) return { ok: false, response: unauthorized() };

  const getUser = deps.getUser ?? defaultGetUser;
  const user = await getUser(token);
  if (!user) return { ok: false, response: unauthorized() };

  return { ok: true, caller: { kind: "user", companyId: user.id } };
}

export type CompanyScope =
  { ok: true; companyId: string } | { ok: false; status: number; response: Response };

/**
 * ボディの `company_id` をどこまで信じるかを決める（S-4-3）。
 *
 * - `internal`（cron・内部呼び出し）: ボディを採用する。呼び出し元は自分自身なので
 * - `user`: **ボディを無視して JWT 由来の company_id を使う。** 明示指定が不一致なら 403。
 *   `src/lib/auth/company.ts` の `getAuthedContext()` が Next.js 側で採った
 *   「company_id を呼び出し側から受け取らない」と同じ思想を Edge 側に持ち込む
 */
export function resolveCompanyId(
  caller: ResolvedCaller,
  bodyCompanyId: string | undefined | null,
): CompanyScope {
  if (caller.kind === "internal") {
    if (!bodyCompanyId) {
      return {
        ok: false,
        status: 400,
        response: jsonResponse(400, { error: "company_id is required" }),
      };
    }
    return { ok: true, companyId: bodyCompanyId };
  }

  const own = caller.companyId;
  if (!own) return { ok: false, status: 401, response: unauthorized() };

  if (bodyCompanyId && bodyCompanyId !== own) {
    return { ok: false, status: 403, response: jsonResponse(403, { error: "forbidden" }) };
  }

  return { ok: true, companyId: own };
}
