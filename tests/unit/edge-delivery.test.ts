import { describe, it, expect } from "vitest";
import {
  MAX_SEND_ATTEMPTS,
  DELIVERY_STATUSES,
  InvalidPeriodError,
  jstDateKey,
  isoWeekKey,
  resolvePulsePeriod,
  resolveWeeklyPeriod,
  deliveryKey,
  deliverOnce,
  type DeliveryStatus,
} from "@edge/_shared/delivery";
import { DbError } from "@edge/_shared/db";

/**
 * S-2-7 / S-2-8: 二重送信の起きない順序。
 *
 * 修復前は「Resend へ送信 → `delivery_log` へ INSERT」の順で、
 * **送信後のDB書き込みが失敗すると痕跡が何も残らなかった**。再試行すると2通目が出る。
 *
 * ここで固定するのは3つ。
 * 1. **予約（INSERT）が送信より先に起きる**
 * 2. **一意制約違反なら送信しない**（送信関数が呼ばれないこと自体を見る）
 * 3. **送信後のDB失敗を注入しても、再試行で2通目が出ない**
 */

// ── 呼び出し順を記録する偽DB ────────────────────────────────

interface Row {
  id: string;
  company_id: string;
  channel: string;
  delivery_type: string;
  content: Record<string, unknown>;
  status: DeliveryStatus;
  attempts: number;
  idempotency_key: string | null;
  created_at: string;
  sent_at?: string | null;
}

const UNIQUE_VIOLATION = {
  message: "duplicate key value violates unique constraint",
  code: "23505",
};

class FakeDb {
  rows: Row[] = [];
  /** insert / select / update / send の発生順 */
  calls: string[] = [];
  /** 次の UPDATE を1回だけ失敗させる（送信後のDB失敗を注入する） */
  failNextUpdate = false;

  from(table: string) {
    if (table !== "delivery_log") throw new Error(`想定外のテーブル: ${table}`);
    return {
      insert: (raw: Record<string, unknown>) => {
        const row = raw as unknown as Row;
        this.calls.push("insert");
        if (
          row.idempotency_key &&
          this.rows.some((r) => r.idempotency_key === row.idempotency_key)
        ) {
          return Promise.resolve({ data: null, error: UNIQUE_VIOLATION });
        }
        this.rows.push({ ...row });
        return Promise.resolve({ data: null, error: null });
      },
      select: () => ({
        eq: (column: string, value: string) => ({
          maybeSingle: () => {
            this.calls.push("select");
            const row = this.rows.find(
              (r) => (r as unknown as Record<string, unknown>)[column] === value,
            );
            return Promise.resolve({ data: row ?? null, error: null });
          },
        }),
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: (column: string, value: string) => {
          this.calls.push("update");
          if (this.failNextUpdate) {
            this.failNextUpdate = false;
            return Promise.resolve({
              data: null,
              error: { message: "connection reset", code: "08006" },
            });
          }
          const row = this.rows.find(
            (r) => (r as unknown as Record<string, unknown>)[column] === value,
          );
          if (row) Object.assign(row, patch);
          return Promise.resolve({ data: null, error: null });
        },
      }),
    };
  }
}

const COMPANY = "00000000-0000-0000-0000-0000000005e1";

function input(overrides: Partial<Parameters<typeof deliverOnce>[1]> = {}) {
  return {
    companyId: COMPANY,
    channel: "email",
    deliveryType: "pulse",
    idempotencyKey: `pulse:${COMPANY}:2026-08-19`,
    content: { lines: ["a", "b"] },
    now: new Date("2026-08-20T00:00:00Z"),
    ...overrides,
  } as Parameters<typeof deliverOnce>[1];
}

/** 送信の代わり。呼ばれたことを db.calls に残す */
function sender(db: FakeDb, result: { ok: boolean; emailId?: string; error?: string }) {
  return () => {
    db.calls.push("send");
    return Promise.resolve(result);
  };
}

// ── 対象期間・対象ID ────────────────────────────────────────

describe("冪等キーの対象期間", () => {
  it("jstDateKey は UTC を JST に寄せてから日付にする", () => {
    // 2026-08-19T15:30Z = JST 2026-08-20 00:30
    expect(jstDateKey(new Date("2026-08-19T15:30:00Z"))).toBe("2026-08-20");
    expect(jstDateKey(new Date("2026-08-19T14:30:00Z"))).toBe("2026-08-19");
  });

  it("target_date の明示指定が導出より優先される（再実行を厳密に冪等にする）", () => {
    const now = new Date("2026-08-20T00:02:00Z");
    expect(resolvePulsePeriod(now, "2026-08-19")).toBe("2026-08-19");
  });

  it("明示指定が無ければ「報告対象日」＝JSTの前日を導出する", () => {
    // JST 2026-08-20 09:00 の実行 → 報告対象は 2026-08-19
    expect(resolvePulsePeriod(new Date("2026-08-20T00:00:00Z"), null)).toBe("2026-08-19");
  });

  it("導出は境界をまたぐと変わる。だから明示指定の経路が要る（実測の記録）", () => {
    // JST 23:58 の実行と JST 00:02 の実行では導出結果が1日ずれる
    const before = resolvePulsePeriod(new Date("2026-08-19T14:58:00Z"), null);
    const after = resolvePulsePeriod(new Date("2026-08-19T15:02:00Z"), null);
    expect(before).not.toBe(after);
    // 明示指定すれば、またいでも同じキーになる
    expect(resolvePulsePeriod(new Date("2026-08-19T14:58:00Z"), "2026-08-18")).toBe(
      resolvePulsePeriod(new Date("2026-08-19T15:02:00Z"), "2026-08-18"),
    );
  });

  it("不正な target_date は InvalidPeriodError（DBにも外部にも触る前に落とす）", () => {
    expect(() => resolvePulsePeriod(new Date(), "2026/08/19")).toThrow(InvalidPeriodError);
    expect(() => resolvePulsePeriod(new Date(), "2026-13-01")).toThrow(InvalidPeriodError);
    expect(() => resolvePulsePeriod(new Date(), "2026-02-30")).toThrow(InvalidPeriodError);
  });

  it("isoWeekKey は JST の ISO 週を返す", () => {
    // 2026-08-19 は水曜。ISO週は 2026-W34
    expect(isoWeekKey(new Date("2026-08-19T03:00:00Z"))).toBe("2026-W34");
    // 年またぎ: 2027-01-01(金) は 2026-W53
    expect(isoWeekKey(new Date("2027-01-01T03:00:00Z"))).toBe("2026-W53");
  });

  it("target_week の明示指定が優先され、不正な値は落ちる", () => {
    expect(resolveWeeklyPeriod(new Date("2026-08-24T00:00:00Z"), "2026-W34")).toBe("2026-W34");
    expect(() => resolveWeeklyPeriod(new Date(), "2026-W54")).toThrow(InvalidPeriodError);
    expect(() => resolveWeeklyPeriod(new Date(), "2026-34")).toThrow(InvalidPeriodError);
  });
});

describe("冪等キーの組み立て", () => {
  it("5つの配信種別のキーが決まった形になる", () => {
    expect(deliveryKey({ kind: "pulse", companyId: COMPANY, period: "2026-08-19" })).toBe(
      `pulse:${COMPANY}:2026-08-19`,
    );
    expect(deliveryKey({ kind: "weekly", companyId: COMPANY, period: "2026-W34" })).toBe(
      `weekly:${COMPANY}:2026-W34`,
    );
    expect(deliveryKey({ kind: "alert", companyId: COMPANY, eventId: "evt_001" })).toBe(
      `alert:${COMPANY}:evt_001`,
    );
    expect(deliveryKey({ kind: "day0", companyId: COMPANY })).toBe(`day0:${COMPANY}`);
    expect(
      deliveryKey({
        kind: "onetap_calendar",
        companyId: COMPANY,
        findingId: "f1",
        recipientId: "r1",
        action: "create",
      }),
    ).toBe(`onetap_calendar:${COMPANY}:f1:r1:create`);
  });

  it("category はキーに入らない（リトライ間で揺れうる値を混ぜない）", () => {
    const key = deliveryKey({ kind: "alert", companyId: COMPANY, eventId: "evt_001" });
    expect(key).not.toContain("site_down");
    expect(key.split(":")).toHaveLength(3);
  });
});

// ── 予約 → 送信 → 更新 ──────────────────────────────────────

describe("deliverOnce の順序 (S-2-7)", () => {
  it("予約(INSERT)が送信より先に起きる", async () => {
    const db = new FakeDb();
    const r = await deliverOnce(db, input(), sender(db, { ok: true, emailId: "re_1" }));

    expect(db.calls).toEqual(["insert", "send", "update"]);
    expect(r.outcome).toBe("sent");
    expect(db.rows[0].status).toBe("sent");
    expect(db.rows[0].attempts).toBe(1);
  });

  it("予約の時点で status は sending（送信前に「送るつもり」がDBに残る）", async () => {
    const db = new FakeDb();
    let statusAtSendTime: string | undefined;

    await deliverOnce(db, input(), () => {
      db.calls.push("send");
      statusAtSendTime = db.rows[0].status;
      return Promise.resolve({ ok: true, emailId: "re_1" });
    });

    expect(statusAtSendTime).toBe("sending");
  });

  it("送信成功で email_id が content に残る", async () => {
    const db = new FakeDb();
    await deliverOnce(db, input(), sender(db, { ok: true, emailId: "re_abc" }));
    expect(db.rows[0].content).toMatchObject({ email_id: "re_abc" });
    expect(db.rows[0].sent_at).toBeTruthy();
  });
});

describe("deliverOnce の重複抑止 (S-2-8)", () => {
  it("既に sent のキーでは送信関数が呼ばれない", async () => {
    const db = new FakeDb();
    await deliverOnce(db, input(), sender(db, { ok: true, emailId: "re_1" }));
    db.calls = [];

    const r = await deliverOnce(db, input(), sender(db, { ok: true, emailId: "re_2" }));

    expect(db.calls).not.toContain("send");
    expect(r.outcome).toBe("skipped");
    expect(r).toMatchObject({ reason: "already-sent" });
  });

  it("**送信後のDB失敗を注入しても、再試行で2通目が出ない**", async () => {
    const db = new FakeDb();
    db.failNextUpdate = true;

    // 1回目: 送信は成功したが結果の記録に失敗した
    const first = await deliverOnce(db, input(), sender(db, { ok: true, emailId: "re_1" }));
    expect(first.outcome).toBe("sent-but-unrecorded");
    expect(first).toMatchObject({ emailId: "re_1" });

    // 行は sending のまま残る＝「送ったか分からない」が消えない
    expect(db.rows[0].status).toBe("sending");

    // 2回目: 送信関数は一度も呼ばれない
    db.calls = [];
    const second = await deliverOnce(db, input(), sender(db, { ok: true, emailId: "re_2" }));

    expect(db.calls).not.toContain("send");
    expect(second.outcome).toBe("skipped");
    expect(second).toMatchObject({ reason: "in-flight" });
  });

  it("送信失敗は failed になり、再試行で送信関数が呼ばれる（attempts が増える）", async () => {
    const db = new FakeDb();
    await deliverOnce(db, input(), sender(db, { ok: false, error: "Resend 500" }));
    expect(db.rows[0].status).toBe("failed");
    expect(db.rows[0].attempts).toBe(1);

    db.calls = [];
    const r = await deliverOnce(db, input(), sender(db, { ok: true, emailId: "re_2" }));

    expect(db.calls).toContain("send");
    expect(r.outcome).toBe("sent");
    expect(db.rows[0].attempts).toBe(2);
  });

  it("再試行の上限に達したら送信せず、その事実を返す（黙って止まらない）", async () => {
    const db = new FakeDb();
    for (let i = 0; i < MAX_SEND_ATTEMPTS; i++) {
      await deliverOnce(db, input(), sender(db, { ok: false, error: "Resend 500" }));
    }
    expect(db.rows[0].attempts).toBe(MAX_SEND_ATTEMPTS);

    db.calls = [];
    const r = await deliverOnce(db, input(), sender(db, { ok: true, emailId: "re_x" }));

    expect(db.calls).not.toContain("send");
    expect(r.outcome).toBe("attempts-exhausted");
    expect(r).toMatchObject({ attempts: MAX_SEND_ATTEMPTS });
  });

  it("予約の INSERT が 23505 以外で失敗したら DbError で落ちる（握りつぶさない）", async () => {
    const db = new FakeDb();
    db.from = () =>
      ({
        insert: () =>
          Promise.resolve({
            data: null,
            error: { message: 'column "x" does not exist', code: "42703" },
          }),
      }) as unknown as ReturnType<FakeDb["from"]>;

    await expect(deliverOnce(db, input(), sender(db, { ok: true }))).rejects.toThrow(DbError);
    expect(db.calls).not.toContain("send");
  });
});

describe("繰り延べ（deliver-alert の静音時間）", () => {
  it("intent が defer なら送信関数を呼ばず、status deferred で予約する", async () => {
    const db = new FakeDb();
    const r = await deliverOnce(db, input({ intent: "defer" }), sender(db, { ok: true }));

    expect(db.calls).toEqual(["insert"]);
    expect(r.outcome).toBe("deferred");
    expect(db.rows[0].status).toBe("deferred");
    expect(db.rows[0].attempts).toBe(0);
  });

  it("**deferred → sent は同一行の UPDATE になる**（別行にすると一意制約違反になるため）", async () => {
    const db = new FakeDb();
    await deliverOnce(db, input({ intent: "defer" }), sender(db, { ok: true }));
    const reservedId = db.rows[0].id;

    const r = await deliverOnce(db, input(), sender(db, { ok: true, emailId: "re_1" }));

    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].id).toBe(reservedId);
    expect(db.rows[0].status).toBe("sent");
    expect(r).toMatchObject({ outcome: "sent", id: reservedId });
  });

  it("既に繰り延べ済みのキーを再度繰り延べても行が増えない", async () => {
    const db = new FakeDb();
    await deliverOnce(db, input({ intent: "defer" }), sender(db, { ok: true }));
    const r = await deliverOnce(db, input({ intent: "defer" }), sender(db, { ok: true }));

    expect(db.rows).toHaveLength(1);
    expect(r.outcome).toBe("skipped");
    expect(r).toMatchObject({ reason: "already-recorded" });
  });
});

describe("status の集合", () => {
  it("00024 の CHECK 制約と同じ7値である", () => {
    expect([...DELIVERY_STATUSES].sort()).toEqual(
      ["confirmed", "deferred", "draft", "failed", "sending", "sent", "skipped"].sort(),
    );
  });
});
