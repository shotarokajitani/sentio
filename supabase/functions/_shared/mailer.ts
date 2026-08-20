/**
 * Resend への送信を1箇所に寄せる（契約 S-2-6 / `slice-01` E+1・E+3・E+5）。
 *
 * 同じ処理が `day0` / `deliver-alert` / `deliver-pulse` / `deliver-weekly` の4本に
 * コピーされており、過去に**同じ欠陥を4回直す**ことになった（`docs/incident.md` の
 * Day0未着事故・2026-07-28 と、その残穴是正・2026-07-29）。1本にする。
 *
 * ここで守る規則は2つ。
 *
 * 1. **設定が無いときに黙ってスキップしない。** `RESEND_API_KEY` / `RESEND_FROM` が
 *    欠けていたら送らずに失敗させる。`onboarding@resend.dev` へのフォールバックは
 *    作らない（サンドボックス扱いでアカウントオーナー以外に届かず、
 *    「送ったつもり」が最も見えにくい形で残る）
 * 2. **レスポンスのステータスコードを必ず見る。** 未確認のまま `ok` を返さない
 */

export interface MailConfig {
  apiKey: string;
  from: string;
}

export type MailConfigResult = { ok: true; config: MailConfig } | { ok: false; missing: string[] };

type EnvReader = (key: string) => string | undefined;

const denoEnv: EnvReader = (key) =>
  (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(key);

/**
 * 送信設定を取り出す。**片方でも欠けたら送らない**（fail-closed）。
 * 呼び出し元は予約（`delivery_log` への INSERT）より**前に**これを見ること。
 * 送るつもりが無いのに予約行を作ると、後始末が要るだけ増える。
 */
export function resolveMailConfig(getEnv: EnvReader = denoEnv): MailConfigResult {
  const apiKey = (getEnv("RESEND_API_KEY") ?? "").trim();
  const from = (getEnv("RESEND_FROM") ?? "").trim();

  const missing: string[] = [];
  if (!apiKey) missing.push("RESEND_API_KEY");
  if (!from) missing.push("RESEND_FROM");

  return missing.length > 0 ? { ok: false, missing } : { ok: true, config: { apiKey, from } };
}

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendOutcome {
  ok: boolean;
  emailId?: string;
  error?: string;
}

/**
 * 送信する。**戻り値で成否を返し、throw しない。**
 *
 * 送信は「予約 → 送信 → 更新」の真ん中に置かれるので、ここで throw すると
 * 「送ったかどうか分からない」まま予約行の更新経路ごと飛ぶ。
 * 例外も含めて失敗を**値**にして返し、`deliverOnce` に状態遷移を任せる。
 */
export async function sendEmail(
  config: MailConfig,
  message: MailMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<SendOutcome> {
  let res: Response;
  try {
    res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    });
  } catch (e) {
    return { ok: false, error: `Resend への接続に失敗: ${(e as Error).message}` };
  }

  const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };

  if (!res.ok) {
    return { ok: false, error: `Resend ${res.status}: ${body.message ?? JSON.stringify(body)}` };
  }

  // 200 でも id が無ければ送れたと見なさない。「未確認のまま ok を返さない」の徹底
  if (!body.id) {
    return { ok: false, error: `Resend ${res.status}: レスポンスに id が無い` };
  }

  return { ok: true, emailId: body.id };
}
