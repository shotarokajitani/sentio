/**
 * 画面からの連携解除（契約 docs/contracts/slice-disconnect.md の D-1 系）。
 *
 * **API 側は一切変えない。** `POST /api/connections/disconnect` は既に fail-closed
 * （company_id はセッションのみ / 数えてから消す / count の null を 0 に丸めない）で、
 * このスライスが足すのは「そこへ到達する経路」だけである。ここに削除の判断を
 * 二重に持たせない。
 *
 * このモジュールが持つ責任は1つだけ:
 * **二段確認に通らない限り、ネットワークに出ない。**
 *
 * 受入基準 D-1-2 が要求しているのは「解除が実行されない」ではなく
 * 「**API が呼ばれない**」である。確認を API 側に任せると、確認欄の実装が壊れた日に
 * 削除がそのまま走る。照合を `fetch` の手前に置き、ここを唯一の入口にする。
 *
 * コンポーネント（`connect-client.tsx`）ではなくモジュールに置いてあるのは、
 * DOM を起こさずに「呼ばれないこと」を試験できるようにするためである
 * （`tests/unit/disconnect-confirm.test.ts`）。
 */

/** 解除 API の場所。呼び出し元の実在検査（`check:endpoint-callers`）はこの文字列を見る */
export const DISCONNECT_ENDPOINT = "/api/connections/disconnect";

export type DisconnectOutcome =
  | { ok: true; eventsDeleted: number }
  /** 二段確認に通らなかった。**API は呼んでいない** */
  | { ok: false; reason: "confirmation_mismatch" }
  /** 409。件数の門に当たったので**何も消していない**（D-1-5） */
  | { ok: false; reason: "deletion_blocked"; count: number | null }
  /** それ以外の失敗。消えたかどうかは断定しない */
  | { ok: false; reason: "failed"; status: number | null };

/**
 * 照合用に文字列を揃える。前後の空白を落とし、大文字小文字を無視する（U-2 の確定）。
 *
 * 中間の空白は落とさない。落とすと別のアドレスを同一視してしまう。
 */
export function normalizeConfirmation(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * 入力がアカウントのメールアドレスと一致するか。
 *
 * `accountEmail` が無い（セッションから取れなかった）ときは**何を打っても false**。
 * 「正本が無い＝素通し」に丸めると、二段確認が形だけ残って中身が消える。
 */
export function confirmationMatches(typed: string, accountEmail: string | null): boolean {
  if (!accountEmail) return false;

  const expected = normalizeConfirmation(accountEmail);
  if (expected === "") return false;

  return normalizeConfirmation(typed) === expected;
}

/**
 * 二段確認に通ったときだけ、既存の解除 API を呼ぶ。
 *
 * `fetchImpl` は試験から差し替えるための注入口である（`token-refresh.ts` の `getEnv` と同じ形）。
 * 本番コードに試験用の分岐を作らないための引数であって、挙動を変えるスイッチではない。
 */
export async function requestDisconnect(input: {
  provider: string;
  typed: string;
  accountEmail: string | null;
  fetchImpl?: typeof fetch;
}): Promise<DisconnectOutcome> {
  // ここが唯一の関門。**通らなければネットワークに出ない**（受入基準 D-1-2）
  if (!confirmationMatches(input.typed, input.accountEmail)) {
    return { ok: false, reason: "confirmation_mismatch" };
  }

  const doFetch = input.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch(DISCONNECT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // provider だけを送る。company_id を本文で受け取る経路を作らない（既存 API の前提）
      body: JSON.stringify({ provider: input.provider }),
    });
  } catch {
    // 届いたかどうかが分からない。**消えたことにしない**
    return { ok: false, reason: "failed", status: null };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  // 409 は「数えたら想定を超えたので消さずに止めた」。成功と混ぜない（D-1-5）
  if (res.status === 409) {
    const count = (body as { count?: unknown } | null)?.count;
    return {
      ok: false,
      reason: "deletion_blocked",
      count: typeof count === "number" ? count : null,
    };
  }

  if (!res.ok) {
    return { ok: false, reason: "failed", status: res.status };
  }

  // 200 でも本文が読めない／件数が数でないなら、消えたと断定できる材料が無い
  const deleted = (body as { eventsDeleted?: unknown } | null)?.eventsDeleted;
  if (typeof deleted !== "number") {
    return { ok: false, reason: "failed", status: res.status };
  }

  return { ok: true, eventsDeleted: deleted };
}
