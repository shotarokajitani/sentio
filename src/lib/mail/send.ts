/**
 * Next 側からメールを1通送る（発注 A-7）。
 *
 * **Edge の `_shared/mailer.ts` とは別物として置く。** Edge Function は
 * `supabase/functions/` の外を import できず、Next も Edge の中を import できない。
 * 二重実装になるので、**名前を具体的にして衝突を避ける**
 * （`check:dual-impl` は関数名でしか照合しない。同名の別物を宣言台帳に載せると台帳が嘘になる）。
 *
 * ここを使うのは webhook だけである。**定期配信は Edge 側が持つ。**
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface NextMailConfig {
  apiKey: string;
  from: string;
}

export type NextMailConfigResult =
  { ok: true; config: NextMailConfig } | { ok: false; missing: string[] };

/**
 * 送信設定を読む。**欠けていたら送らない**（fail-closed）。
 *
 * 設定が無いのに送ろうとすると、Resend が 401 を返すまで気づけない。
 * 何が足りないかを値で返し、呼び出し側がログに残す。
 */
export function resolveNextMailConfig(): NextMailConfigResult {
  const apiKey = process.env.RESEND_API_KEY?.trim() ?? "";
  const from = process.env.RESEND_FROM?.trim() ?? "";

  const missing: string[] = [];
  if (!apiKey) missing.push("RESEND_API_KEY");
  if (!from) missing.push("RESEND_FROM");
  if (missing.length > 0) return { ok: false, missing };

  return { ok: true, config: { apiKey, from } };
}

export interface NextMailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface NextMailOutcome {
  ok: boolean;
  emailId?: string;
  error?: string;
}

/**
 * 1通送る。**例外を投げない**（送信の失敗は値で返す）。
 *
 * 呼び出し側は「送れなかった」を記録に残す責任がある。
 * 投げると、購読の更新まで巻き戻ったように見えてしまう。
 */
export async function sendNextEmail(
  config: NextMailConfig,
  input: NextMailInput,
  fetchImpl: typeof fetch = fetch,
): Promise<NextMailOutcome> {
  try {
    const res = await fetchImpl(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.from,
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
    });

    if (!res.ok) {
      // 本文には宛先や鍵が載りうるので、状態コードだけを残す
      return { ok: false, error: `resend status ${res.status}` };
    }

    const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
    return { ok: true, emailId: typeof body?.id === "string" ? body.id : undefined };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "unknown" };
  }
}

/**
 * Next 側の送信に必要な環境変数。**Vercel にも入っていないと1通も出ない。**
 *
 * Supabase の Function Secrets に入っていても Next からは見えない。
 * `next.config.ts` がビルド時にここを読み、欠けていれば1行出す
 * （**Vercel の env は CI からは読めないので、ビルドログが唯一の可視化になる**）。
 */
export const NEXT_MAIL_ENV_KEYS = ["RESEND_API_KEY", "RESEND_FROM"] as const;

/** 送れなかった理由として `delivery_log.last_error` に入れる値（発注 A-1） */
export const MAIL_CONFIG_MISSING = "mail_config_missing";

export interface MailFailureRecord {
  companyId: string;
  deliveryType: string;
  idempotencyKey: string;
  missing: string[];
}

/**
 * 送信設定が無くて送らなかったことを `delivery_log` に残す（発注 A-1）。
 *
 * **ログだけだと、流れた時点で分からなくなる。**
 * Vercel のログは保持期間があり、「0通だった」のか「一度も試していない」のかを
 * あとから区別できない。行が1つ残っていれば区別できる。
 *
 * 一意制約違反（23505）は**正常な分岐**である。同じ購読について
 * 2回目の webhook が来ただけで、記録は既に1行ある。
 *
 * **例外を投げない。** ここで投げると、記録の失敗が購読の更新を巻き戻したように見える。
 */
export interface MailFailureDb {
  from(table: string): {
    insert(row: Record<string, unknown>): PromiseLike<{ error: unknown }>;
  };
}

export async function recordMailConfigMissing(
  admin: MailFailureDb,
  record: MailFailureRecord,
): Promise<{ recorded: boolean; reason?: string }> {
  const now = new Date().toISOString();
  const { error } = await admin.from("delivery_log").insert({
    company_id: record.companyId,
    channel: "email",
    delivery_type: record.deliveryType,
    // **何が足りなかったかを残す。** 「送れなかった」だけでは直せない
    content: { missing: record.missing },
    status: "failed",
    last_error: MAIL_CONFIG_MISSING,
    last_error_at: now,
    attempts: 0,
    idempotency_key: record.idempotencyKey,
    created_at: now,
  });

  if (!error) return { recorded: true };
  const code = (error as { code?: string }).code;
  if (code === "23505") return { recorded: false, reason: "already_recorded" };
  return { recorded: false, reason: (error as { message?: string }).message ?? "unknown" };
}
