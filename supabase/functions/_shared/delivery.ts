/**
 * 配信の冪等性（契約 S-2-6 〜 S-2-8 / マイグレーション `00024`）。
 *
 * **順序が要件である: 予約(INSERT) → 送信 → 結果でUPDATE。**
 *
 * 修復前は「Resend へ送信 → `delivery_log` へ INSERT」の順だった
 * （`deliver-pulse/index.ts:98,127`）。この順序では**送信後のDB書き込みが失敗すると
 * 痕跡が何も残らない**。再試行するとDBには何も無いので2通目が出る。
 * 順序を反転させると「送ったかどうか分からない」状態が必ずDBに残り、
 * **判断の材料が消えない。**
 *
 * `sending` は「送っていない」ではなく「**送った可能性がある**」と解釈する。
 * 二重送信より未送信のほうが害が小さいという判断による
 * （Sentio は何も勝手に送らない。CLAUDE.md 絶対規則）。
 * `sending` のまま固まった行の復旧は人間の手順に寄せる
 * （`docs/runbooks/2026-08-20_delivery-idempotency.md`）。自動で期限切れにしない。
 *
 * 送信そのものはこのモジュールの外（呼び出し元が渡す `send`）に置く。
 * ここが握るのは順序と状態遷移だけなので、Resend に触らずにテストで固定できる。
 */

import { DbError, mustData, mustMaybe, mustOk, takeError } from "./db.ts";
import { isoWeekKey, jstDateKey } from "./jst.ts";

/** `00024` の CHECK 制約と同じ集合。片方を変えたらもう片方も変える。 */
export const DELIVERY_STATUSES = [
  "sending",
  "sent",
  "failed",
  "skipped",
  "deferred",
  "draft",
  "confirmed",
] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * 送信の再試行上限。
 *
 * `MAX_FULL_RUNS_PER_DAY` と同じ作法で**ここ1箇所だけに置く。環境変数化しない**。
 * 上限に達したら再試行せず、**その事実をレスポンスとログに残す**（黙って止まらない）。
 * 到達した行は `status = failed` かつ `attempts >= MAX_SEND_ATTEMPTS` で識別できる。
 */
export const MAX_SEND_ATTEMPTS = 3;

/** PostgreSQL の一意制約違反。予約が衝突したことの唯一の判定材料 */
const UNIQUE_VIOLATION = "23505";

/** 対象期間の指定が不正。**DBにも外部にも触る前に**落とすために使う */
export class InvalidPeriodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPeriodError";
  }
}

export function isInvalidPeriodError(e: unknown): e is InvalidPeriodError {
  return e instanceof InvalidPeriodError;
}

// ── 対象期間 ────────────────────────────────────────────────

// 日付キーの基準は `_shared/jst.ts` に1本化してある（**常に JST 基準**）。
// ここから再輸出しているのは、対象期間の解決とキーの組み立てが同じ場所で読めるようにするため
export { isoWeekKey, jstDateKey } from "./jst.ts";

function assertValidDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new InvalidPeriodError(`target_date は YYYY-MM-DD 形式で渡すこと: ${value}`);
  }
  // 2026-02-30 のような「形式は合うが存在しない日」を弾く。
  // Date は繰り上げてしまうため、往復させて一致を見る
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new InvalidPeriodError(`存在しない日付: ${value}`);
  }
}

function assertValidWeek(value: string): void {
  const m = /^(\d{4})-W(\d{2})$/.exec(value);
  if (!m) {
    throw new InvalidPeriodError(`target_week は YYYY-Www 形式で渡すこと: ${value}`);
  }
  const week = Number(m[2]);
  // ISO 週は年によって 52 か 53。53 を超える値は必ず不正
  if (week < 1 || week > 53) {
    throw new InvalidPeriodError(`ISO 週の範囲外: ${value}`);
  }
}

/**
 * デイリーパルスの対象期間。
 *
 * **明示指定を優先する。** 導出（JSTの前日）は `now` に依存するため、
 * JST 23:58 の実行と 00:02 の再実行で1日ずれる。cron の通常運転は導出で足りるが、
 * **手動再実行を厳密に冪等にするには明示指定の経路が要る**（S-4-10 の
 * `workflow_dispatch` から再送を試せる形にもなる）。
 */
export function resolvePulsePeriod(now: Date, explicit?: string | null): string {
  if (explicit !== undefined && explicit !== null && explicit !== "") {
    assertValidDate(explicit);
    return explicit;
  }
  return jstDateKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
}

/** 週次の対象期間。`resolvePulsePeriod` と同じ理由で明示指定を優先する。 */
export function resolveWeeklyPeriod(now: Date, explicit?: string | null): string {
  if (explicit !== undefined && explicit !== null && explicit !== "") {
    assertValidWeek(explicit);
    return explicit;
  }
  return isoWeekKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
}

// ── 冪等キー ────────────────────────────────────────────────

/**
 * 冪等キーの材料。**会社 / 種別 / 対象期間 or 対象ID** の3次元で決まる。
 *
 * `category` のような「リトライ間で値が揺れうる要素」は入れない。
 * 揺れた瞬間に別キー扱いになり、二重送信を防ぐという第一目的が崩れるため。
 */
export type DeliveryKeyInput =
  | { kind: "pulse"; companyId: string; period: string }
  | { kind: "weekly"; companyId: string; period: string }
  | { kind: "alert"; companyId: string; eventId: string }
  | { kind: "day0"; companyId: string }
  | {
      kind: "onetap_calendar";
      companyId: string;
      findingId: string;
      recipientId: string;
      action: string;
    };

/** 冪等キーの組み立ては**ここだけ**。関数ごとに書くとキーの形が割れる。 */
export function deliveryKey(input: DeliveryKeyInput): string {
  switch (input.kind) {
    case "pulse":
    case "weekly":
      return `${input.kind}:${input.companyId}:${input.period}`;
    case "alert":
      return `alert:${input.companyId}:${input.eventId}`;
    case "day0":
      return `day0:${input.companyId}`;
    case "onetap_calendar":
      return `onetap_calendar:${input.companyId}:${input.findingId}:${input.recipientId}:${input.action}`;
  }
}

// ── 予約 → 送信 → 更新 ──────────────────────────────────────

interface QueryResult<T> {
  data: T;
  error: { message: string; code?: string } | null;
}

interface ReservedRow {
  id: string;
  status: DeliveryStatus;
  attempts: number;
}

/**
 * `delivery_log` に触れるのに必要な最小限だけを型にしてある。
 * テストは偽物をそのまま渡せる（順序を記録するため）。
 *
 * 実物の Supabase クライアントは**構造的にはこれを満たす**が、
 * `PostgrestQueryBuilder` の総称型と関係付けようとすると TypeScript が
 * `TS2589 Type instantiation is excessively deep` で落ちる
 * （2026-08-19 の CI `deno check` で実測）。したがって境界で `asDeliveryDb()` を通す。
 *
 * **キャストで型検査を捨てているので、実クライアントとの噛み合わせは実物で見る。**
 * `tests/integration/delivery-idempotency.test.ts` が実 supabase-js クライアントと
 * 実DBに対して `deliverOnce()` を直接動かしている（送信関数は注入するのでメールは出ない）。
 */
export interface DeliveryDb {
  from(table: string): {
    insert(row: Record<string, unknown>): PromiseLike<QueryResult<unknown>>;
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): { maybeSingle(): PromiseLike<QueryResult<ReservedRow | null>> };
    };
    update(patch: Record<string, unknown>): {
      eq(column: string, value: string): PromiseLike<QueryResult<unknown>>;
    };
  };
}

/**
 * 実物の Supabase クライアントを `DeliveryDb` として扱う。
 * 上のコメントのとおり、総称型どうしの関係付けが `TS2589` で落ちるための境界。
 * ここ以外でキャストしない（キャストが散らばると噛み合わせの確認箇所が散る）。
 */
export function asDeliveryDb(client: unknown): DeliveryDb {
  return client as DeliveryDb;
}

export interface SendOutcome {
  ok: boolean;
  emailId?: string;
  error?: string;
}

export interface DeliverInput {
  companyId: string;
  channel: string;
  deliveryType: string;
  idempotencyKey: string;
  content: Record<string, unknown>;
  now: Date;
  /** `defer` は「送らずに繰り延べを記録する」（deliver-alert の静音時間） */
  intent?: "send" | "defer";
}

export type DeliverResult =
  | { outcome: "sent"; id: string; emailId?: string; attempts: number }
  | { outcome: "send-failed"; id: string; error: string; attempts: number }
  /** 送信は完了したが結果を記録できなかった。**S-2-6 の「送信後のDBエラー」** */
  | { outcome: "sent-but-unrecorded"; id: string; emailId?: string; error: string }
  | { outcome: "deferred"; id: string }
  | {
      outcome: "skipped";
      id: string;
      reason: "already-sent" | "in-flight" | "already-recorded";
      status: DeliveryStatus;
    }
  | { outcome: "attempts-exhausted"; id: string; attempts: number };

/** 再試行してよいのは「送っていないと確定できる」状態だけ。 */
const RETRYABLE: readonly DeliveryStatus[] = ["failed", "deferred"];

/**
 * 予約 → 送信 → 更新 を1回だけ行う。
 *
 * 送信関数 `send` は**予約に成功したときしか呼ばれない**。
 * 「一意制約違反なら送信せずスキップ」がこの関数の存在理由なので、
 * 呼び出し元が順序を組み替えられない形にしてある。
 */
export async function deliverOnce(
  db: DeliveryDb,
  input: DeliverInput,
  send: () => Promise<SendOutcome>,
): Promise<DeliverResult> {
  const intent = input.intent ?? "send";
  const reserved = await reserve(db, input, intent);

  if (!reserved.proceed) return reserved.result;
  if (intent === "defer") return { outcome: "deferred", id: reserved.id };

  const sent = await send();

  if (!sent.ok) {
    // 送信していないことが確定しているので、記録の失敗はそのまま失敗にしてよい
    await mustOk(
      db
        .from("delivery_log")
        .update({
          status: "failed",
          content: { ...input.content, send_error: sent.error },
        })
        .eq("id", reserved.id),
      "delivery: mark failed",
    );
    return {
      outcome: "send-failed",
      id: reserved.id,
      error: sent.error ?? "unknown send error",
      attempts: reserved.attempts,
    };
  }

  // ここは throw させない。送信は完了しているので、失敗を**値**として受け取る必要がある
  const error = await takeError(
    db
      .from("delivery_log")
      .update({
        status: "sent",
        sent_at: input.now.toISOString(),
        content: { ...input.content, email_id: sent.emailId },
      })
      .eq("id", reserved.id),
    "delivery: mark sent",
  );

  if (error) {
    // **ここで throw しない。** 送信は完了しているので、その事実を呼び出し元に返す。
    // 行は `sending` のまま残り、次の試行は「送った可能性あり」として止まる（S-2-8）
    console.error(
      `delivery: 送信は成功したが記録に失敗した key=${input.idempotencyKey} email_id=${sent.emailId} err=${error.message}`,
    );
    return {
      outcome: "sent-but-unrecorded",
      id: reserved.id,
      emailId: sent.emailId,
      error: error.message,
    };
  }

  return { outcome: "sent", id: reserved.id, emailId: sent.emailId, attempts: reserved.attempts };
}

type Reservation =
  { proceed: true; id: string; attempts: number } | { proceed: false; result: DeliverResult };

async function reserve(
  db: DeliveryDb,
  input: DeliverInput,
  intent: "send" | "defer",
): Promise<Reservation> {
  const id = crypto.randomUUID();
  const initialStatus: DeliveryStatus = intent === "defer" ? "deferred" : "sending";

  // 一意制約違反は**正常な分岐**（既に予約がある）なので、失敗を値として受け取る
  const error = await takeError(
    db.from("delivery_log").insert({
      id,
      company_id: input.companyId,
      channel: input.channel,
      delivery_type: input.deliveryType,
      content: input.content,
      status: initialStatus,
      attempts: intent === "defer" ? 0 : 1,
      idempotency_key: input.idempotencyKey,
      created_at: input.now.toISOString(),
    }),
    "delivery: reserve",
  );

  if (!error) return { proceed: true, id, attempts: intent === "defer" ? 0 : 1 };

  // 一意制約違反以外は握りつぶさない。列が消えた・権限が無い等はここで失敗させる
  if (error.code !== UNIQUE_VIOLATION) throw error;

  const existing = await mustMaybe<ReservedRow>(
    db
      .from("delivery_log")
      .select("id, status, attempts")
      .eq("idempotency_key", input.idempotencyKey)
      .maybeSingle(),
    "delivery: read reserved row",
  );

  if (!existing) {
    // 一意制約に当たったのに行が引けないのは、キーの組み立てか索引の取り違え。
    // 「たぶん大丈夫」で送ると二重送信になるので落とす
    throw new DbError(
      "delivery: read reserved row",
      `一意制約に違反したが該当行が無い: ${input.idempotencyKey}`,
    );
  }

  if (existing.status === "sent") {
    return {
      proceed: false,
      result: { outcome: "skipped", id: existing.id, reason: "already-sent", status: "sent" },
    };
  }

  if (intent === "defer") {
    return {
      proceed: false,
      result: {
        outcome: "skipped",
        id: existing.id,
        reason: "already-recorded",
        status: existing.status,
      },
    };
  }

  if (!RETRYABLE.includes(existing.status)) {
    // `sending` は「送った可能性がある」。`skipped` / `draft` / `confirmed` は送信経路ではない
    return {
      proceed: false,
      result: {
        outcome: "skipped",
        id: existing.id,
        reason: "in-flight",
        status: existing.status,
      },
    };
  }

  if (existing.attempts >= MAX_SEND_ATTEMPTS) {
    console.error(
      `delivery: 再試行上限に到達したので送信しない key=${input.idempotencyKey} attempts=${existing.attempts}`,
    );
    return {
      proceed: false,
      result: { outcome: "attempts-exhausted", id: existing.id, attempts: existing.attempts },
    };
  }

  const attempts = existing.attempts + 1;
  await mustOk(
    db
      .from("delivery_log")
      .update({
        status: "sending",
        attempts,
        content: input.content,
        delivery_type: input.deliveryType,
      })
      .eq("id", existing.id),
    "delivery: re-reserve",
  );

  return { proceed: true, id: existing.id, attempts };
}
