/**
 * カスタマーポータルを開く（④-b・2026-09-08 決定）。
 *
 * **画面から直接 `fetch` しない**のは `checkout.ts` と同じ理由である——
 * 連打の抑止と失敗の扱いを画面に散らすと、片方だけ直したときに挙動が割れる。
 *
 * **解約は Stripe 側で完結する。** ここが作るのは**入口のリンクだけ**で、
 * 解約の状態を Sentio 側に持たない（持つと `canceled` が終端で順序保証も無いという
 * 2026-09-07 の問題をもう一度背負う）。
 */

export type PortalOutcome =
  | { ok: true }
  /** 前の1回がまだ動いている。**失敗ではない**（押した人から見れば何も起きていない） */
  | { ok: false; reason: "in_flight" }
  /** 購読が無い。画面は購読中のときしか出さないので、通常は起きない */
  | { ok: false; reason: "no_subscription"; status: number }
  | { ok: false; reason: "failed"; status: number };

export const PORTAL_ENDPOINT = "/api/billing/portal";

/** 連打の抑止。**モジュールに閉じる**（画面が状態を持つと二重に持つことになる） */
let inFlight = false;

export async function openBillingPortal(
  fetchImpl: typeof fetch = fetch,
  navigate: (url: string) => void = (url) => {
    window.location.href = url;
  },
): Promise<PortalOutcome> {
  if (inFlight) return { ok: false, reason: "in_flight" };
  inFlight = true;

  try {
    const res = await fetchImpl(PORTAL_ENDPOINT, { method: "POST" });

    if (!res.ok) {
      return res.status === 404
        ? { ok: false, reason: "no_subscription", status: res.status }
        : { ok: false, reason: "failed", status: res.status };
    }

    const body = (await res.json().catch(() => ({}))) as { url?: string };
    if (!body.url) return { ok: false, reason: "failed", status: res.status };

    navigate(body.url);
    return { ok: true };
  } catch {
    // 通信断も失敗として値で返す。**throw して画面を巻き込まない**
    return { ok: false, reason: "failed", status: 0 };
  } finally {
    inFlight = false;
  }
}
