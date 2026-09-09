/**
 * 状態パケット（発注書 ①-a・PS-1 / PS-2）。**LLM を通らない部分の全部。**
 *
 * ここは陰性コントロールが主役である。13-1 の4つ——
 *
 *   (a) `is_established=false` のときに stats の中身が出ない
 *   (b) 走査の3値が「回せなかった」と「候補0件」を区別する
 *   (c) 項目9(c)（構造上見ていないもの）が本文に出る
 *   (d) 値が無い項目が省略されずに「無い」と出る
 *
 * ——を、**壊したら赤くなる形**で置いてある。
 */
import { describe, it, expect } from "vitest";
import {
  INGEST_ROUTES,
  SCAN_IDS,
  attributeCandidate,
  buildStatePacket,
  linkStateOf,
  renderPacketText,
  type PacketBaselineRow,
  type PacketConnection,
  type PacketEvent,
  type PacketInput,
} from "@edge/_shared/state-packet";
import { sourcesForProvider } from "@edge/_shared/retention";
import { runScan } from "@edge/_shared/scan";

const NOW = new Date("2026-09-09T05:00:00.000Z"); // JST 14:00

function event(over: Partial<PacketEvent> & { event_id: string }): PacketEvent {
  return {
    source: "google_calendar",
    event_type: "schedule",
    occurred_at: "2026-09-08T01:00:00.000Z",
    ingested_at: "2026-09-08T02:00:00.000Z",
    metrics: {},
    sensitivity: "S1",
    ...over,
  };
}

function input(over: Partial<PacketInput> = {}): PacketInput {
  return {
    generatedAt: NOW,
    reportDate: "2026-09-09",
    connections: [],
    events: [],
    baselines: [],
    ...over,
  };
}

const ESTABLISHED_INTERVAL: PacketBaselineRow = {
  metric_key: "schedule_interval",
  is_established: true,
  min_obs: 5,
  stats: { median: 3, p25: 1, p75: 12.5, count: 20, iqr: 11.5 },
};

/** 確立していない revenue。**本番の実物と同じ形**（stats が空） */
const UNESTABLISHED_REVENUE: PacketBaselineRow = {
  metric_key: "revenue",
  is_established: false,
  min_obs: 5,
  stats: {},
};

const render = (over: Partial<PacketInput> = {}) => renderPacketText(buildStatePacket(input(over)));

// ──────────────────────────────────────────────────────────

describe("PS-1: 決定的である", () => {
  it("同じ入力からは同じパケットが出る", () => {
    const events = [event({ event_id: "a" }), event({ event_id: "b" })];

    expect(render({ events })).toBe(render({ events }));
  });
});

describe("PS-2 / 13-1(d): 値が無い項目を省略しない", () => {
  it("**空の会社でも9項目すべてが出る**", () => {
    const text = render();

    for (const heading of [
      "【1】",
      "【2】",
      "【3】",
      "【4】",
      "【5】",
      "【6】",
      "【7】",
      "【8】",
      "【9】",
    ]) {
      expect(text, heading).toContain(heading);
    }
  });

  it("空の会社でも、無いものは「無い」と書かれる", () => {
    const text = render();

    expect(text).toContain("まだ1件も取り込んでいません");
    expect(text).toContain("予定が1件も入っていません");
    expect(text).toContain("取引の系列は、まだ束ねられていません");
    expect(text).toContain("連携していません（行がありません）");
  });
});

describe("項目1: いつ時点の状態か", () => {
  it("生成時刻（JST）と報告対象日と取り込み周期が出る", () => {
    const text = render();

    expect(text).toContain("2026年9月9日 14:00");
    expect(text).toContain("2026-09-09");
    // **6時間ごと**という一文が無いと、読み手は「いま」の状態だと読む
    expect(text).toContain("6時間ごとに取り込んでいます");
    expect(text).toContain("最後に取り込んだ時点の状態です");
  });
});

describe("項目2: 連携の生死（status 単独で「つながっている」と書かない）", () => {
  const base: PacketConnection = {
    provider: "google_calendar",
    status: "active",
    expires_at: "2026-09-09T06:00:00.000Z",
    last_refresh: "2026-09-09T04:00:00.000Z",
    revoked_at: null,
  };

  it("期限が更新より後なら「つながっている」", () => {
    expect(linkStateOf(base, NOW)).toBe("connected");
    expect(render({ connections: [base] })).toContain("つながっています");
  });

  it("**status='active' でも期限が更新より前なら「判断がつかない」**", () => {
    // 2026-09-08 の実測（status='active' かつ expires_at が過去）がこの形
    const stale = { ...base, expires_at: "2026-09-09T02:00:00.000Z" };

    expect(linkStateOf(stale, NOW)).toBe("unknown");
    expect(render({ connections: [stale] })).toContain("判断がつきません");
  });

  it("**陰性**: 判断がつかないものを「つながっている」に寄せない", () => {
    const stale = { ...base, expires_at: "2026-09-09T02:00:00.000Z" };
    const text = render({ connections: [stale] });

    expect(text).not.toContain("つながっています");
  });

  it("revoked は「連携が切れている」と検知時刻", () => {
    const revoked = {
      ...base,
      status: "revoked",
      revoked_at: "2026-09-08T18:00:00.000Z",
    };

    expect(linkStateOf(revoked, NOW)).toBe("revoked");
    expect(render({ connections: [revoked] })).toContain("連携が切れています");
  });

  it("3つの値を必ず併記する（status / 期限 / 最後の更新）", () => {
    const text = render({ connections: [base] });

    expect(text).toContain("status=active");
    expect(text).toContain("期限=");
    expect(text).toContain("最後の更新=");
  });
});

describe("項目3: 取り込みの鮮度（取り込んだ日とデータの日付を1つにまとめない）", () => {
  it("source ごとに両方の日付が出る", () => {
    const text = render({
      events: [
        event({
          event_id: "csv1",
          source: "csv:accounting",
          event_type: "transaction",
          // **古いCSVを今日入れた**形。1つにまとめると「最新」に見えてしまう
          occurred_at: "2026-03-01T00:00:00.000Z",
          ingested_at: "2026-09-09T01:00:00.000Z",
        }),
      ],
    });

    expect(text).toContain("取り込んだ日 2026年9月9日 10:00");
    expect(text).toContain("データの日付 2026年3月1日 09:00");
  });

  it("一度も取り込んでいない source も行を出す", () => {
    const text = render();

    for (const source of INGEST_ROUTES) {
      expect(text, source).toContain(`${source}: まだ1件も取り込んでいません`);
    }
  });
});

describe("項目4 / 13-1(a): 確立していないベースラインの中身を書かない", () => {
  it("**陰性**: is_established=false のとき stats の数字が1つも出ない", () => {
    const text = render({
      baselines: [{ ...ESTABLISHED_INTERVAL, is_established: false, stats: {} }],
    });

    expect(text).toContain("まだ出せません");
    // 空の統計を 0 と書かない。中央値・四分位の語も出さない
    expect(text).not.toContain("中央値");
    expect(text).not.toContain("25%点");
  });

  it("あと何件必要かを、実装が持っている条件（min_obs）から出す", () => {
    // 予定が3日ぶん＝間隔2本。min_obs=5 なのであと3本
    const text = render({
      baselines: [{ ...ESTABLISHED_INTERVAL, is_established: false, stats: {} }],
      events: [
        event({ event_id: "s1", occurred_at: "2026-09-01T01:00:00.000Z" }),
        event({ event_id: "s2", occurred_at: "2026-09-03T01:00:00.000Z" }),
        event({ event_id: "s3", occurred_at: "2026-09-05T01:00:00.000Z" }),
      ],
    });

    expect(text).toContain("あと 3 件必要です");
  });

  it("確立していれば中央値・四分位・観測数を出す", () => {
    const text = render({ baselines: [ESTABLISHED_INTERVAL] });

    expect(text).toContain("中央値 3 日");
    expect(text).toContain("25%点 1 日");
    expect(text).toContain("75%点 12.5 日");
    expect(text).toContain("観測 20 件");
  });
});

describe("項目5: 予定の直近", () => {
  it("最後の予定と、いまとの差の日数", () => {
    const text = render({
      events: [event({ event_id: "s1", occurred_at: "2026-09-05T01:00:00.000Z" })],
    });

    expect(text).toContain("4 日前");
  });

  it("1件も無ければそう書く", () => {
    expect(render()).toContain("予定が1件も入っていません");
  });
});

describe("項目6: 取引の間隔（系列ごと）", () => {
  const tx = (id: string, day: string, description: string) =>
    event({
      event_id: id,
      source: "csv:accounting",
      event_type: "transaction",
      occurred_at: `2026-09-${day}T01:00:00.000Z`,
      metrics: { description },
    });

  it("**鍵は description**（本番の取り込みが入れている値）", () => {
    const text = render({
      events: [tx("t1", "01", "A商店"), tx("t2", "03", "A商店"), tx("t3", "05", "A商店")],
    });

    expect(text).toContain("A商店");
  });

  it("間隔が3本に届かない系列は、省略せずに「まだ平常が定まりません」と書く", () => {
    const text = render({ events: [tx("t1", "01", "A商店"), tx("t2", "03", "A商店")] });

    expect(text).toContain("A商店: まだ平常が定まりません（間隔が 1 本）");
  });

  it("系列が0本ならそう書く", () => {
    expect(render()).toContain("取引の系列は、まだ束ねられていません");
  });
});

describe("項目7: 入金（売上と書かない）", () => {
  it("いまは出せないことを書く", () => {
    const text = render();

    expect(text).toContain("入金は出せません。金額の列を読み取れていません");
  });

  it("**陰性**: 項目7に「売上」という語を使わない（必ず「入金」と書く）", () => {
    // metric_key は revenue のままだが、中身は銀行の入金額である。
    // 項目9(a) の「売上（Stripe など）」は**取り込めていないものの名前**なので別物
    const section = render().split("【7】")[1].split("【8】")[0];

    expect(section).not.toContain("売上");
    expect(section).toContain("入金");
  });

  it("3つの枠を空で持つ（件数と金額 / 除外 / 対応づけ）", () => {
    const packet = buildStatePacket(input());

    expect(packet.deposits.count).toBeNull();
    expect(packet.deposits.excludedCount).toBeNull();
    expect(packet.deposits.unmappedColumns).toEqual([]);
    expect(packet.deposits.rowsWithoutAmount).toBe(0);
  });

  it("**7-4: 金額が入らなかった行が1行でもあれば、確からしい値として出さない**", () => {
    const packet = buildStatePacket(
      input({
        deposits: {
          count: 10,
          amount: 1234,
          excludedCount: 0,
          excludedAmount: 0,
          unmappedColumns: ["摘要2"],
          rowsWithoutAmount: 3,
        },
      }),
    );

    expect(packet.deposits.trustworthy).toBe(false);
    expect(renderPacketText(packet)).toContain("入金額は出しません");
    expect(renderPacketText(packet)).not.toContain("1234");
  });

  it("行数が0なら確からしい値として出せる", () => {
    const packet = buildStatePacket(
      input({
        deposits: {
          count: 10,
          amount: 1234,
          excludedCount: 0,
          excludedAmount: 0,
          unmappedColumns: [],
          rowsWithoutAmount: 0,
        },
      }),
    );

    expect(packet.deposits.trustworthy).toBe(true);
  });
});

describe("項目8 / 13-1(b): 走査の3値", () => {
  it("8本を1本ずつ出す（まとめない）", () => {
    const packet = buildStatePacket(input());

    expect(packet.scans).toHaveLength(8);
    expect(packet.scans.map((s) => s.id)).toEqual([...SCAN_IDS]);
  });

  it("**陰性**: 「回せなかった」と「候補0件」を同じ文言にしない", () => {
    const text = render({
      baselines: [ESTABLISHED_INTERVAL],
      events: [event({ event_id: "s1", occurred_at: "2026-09-08T01:00:00.000Z" })],
    });

    // 途絶（会社全体）は回せる。**回して0件**である
    expect(text).toContain("回して候補0件");
    // 監視は入力が無い。**回せなかった**である
    expect(text).toContain("入力が無くて回せませんでした");
  });

  it("回せない理由を1本ずつ書く", () => {
    const packet = buildStatePacket(input());
    const monitor = packet.scans.find((s) => s.id === "monitor");

    expect(monitor?.state).toEqual({
      kind: "unavailable",
      reason: "監視イベント（event_type='monitor'）が0件",
    });
  });

  it("候補が出たら件数を書く", () => {
    // 平常3日の会社で、最後の予定から20日空いている＝途絶（会社全体）が発火する
    const packet = buildStatePacket(
      input({
        baselines: [ESTABLISHED_INTERVAL],
        events: [event({ event_id: "s1", occurred_at: "2026-08-20T01:00:00.000Z" })],
      }),
    );
    const silence = packet.scans.find((s) => s.id === "silence_company");

    expect(silence?.state).toEqual({ kind: "candidates", count: 1 });
  });

  it("候補の同定が `scan.ts` の実物と噛み合っている（会社全体と系列を取り違えない）", () => {
    // **description の形に依存しているので、実物の出力で固定する**
    const events = [
      {
        event_id: "s1",
        occurred_at: "2026-08-20T01:00:00.000Z",
        event_type: "schedule",
        source: "google_calendar",
        metrics: { title: "定例" },
        sensitivity: "S1",
      },
    ];
    const candidates = runScan(
      events,
      [
        {
          metric_key: "schedule_interval",
          is_established: true,
          median: 3,
          iqr: 11.5,
          p25: 1,
          p75: 12.5,
          count: 20,
        },
      ],
      NOW.getTime(),
    );

    expect(candidates.length).toBeGreaterThan(0);
    expect(attributeCandidate(candidates[0])).toBe("silence_company");
  });
});

describe("項目9 / 13-1(c): 見えていないもの", () => {
  it("3つに分けて、名前を挙げて書く", () => {
    const text = render();

    expect(text).toContain("取り込む経路が無いもの:");
    expect(text).toContain("経路はあるが値が来ていないもの:");
    // **ここが落ちると「経路をつなげば全部見える」と読める**
    expect(text).toContain("構造上、見ていないもの:");
  });

  it("**陰性**: (c) の中身が名指しで出る（節ごと消したら赤くなる）", () => {
    const text = render();

    for (const name of [
      "定例が1本だけ消えたこと",
      "間隔が3回に届かない取引先の変化",
      "取引が増えた側の変化",
      "請求と入金のずれ",
      "勘定科目ごとの動き",
    ]) {
      expect(text, name).toContain(name);
    }
  });

  it("件数ではなく名前を出す", () => {
    const packet = buildStatePacket(input());

    expect(packet.blindSpots.noRoute.length).toBeGreaterThan(0);
    expect(packet.blindSpots.byDesign.length).toBeGreaterThan(0);
    for (const name of packet.blindSpots.noRoute) expect(name).not.toMatch(/^\d+件$/);
  });

  it("9-4: 取り込み経路の一覧が実装とずれたら気づける", () => {
    // provider 由来の source（`retention.ts` の正本）＋ CSV の source が
    // `INGEST_ROUTES` と一致していること。**片方だけ増えたらここが落ちる**
    const fromProviders = [
      ...sourcesForProvider("google_calendar"),
      ...sourcesForProvider("freee"),
    ];

    expect([...INGEST_ROUTES].sort()).toEqual(
      [...new Set([...fromProviders, "csv:accounting"])].sort(),
    );
  });
});

describe("8-3: 本番と同じ形の入力で、走査の結論が実測と一致する", () => {
  /**
   * 2026-09-09 の本番の形。
   * - 取引に `metrics.revenue` が無く、`revenue` ベースラインは未確立
   * - `is_overdue` / `external` / `monitor` / 3系列の指標がすべて0件
   * - `schedule_interval` は確立、予定あり、取引の系列は間隔4本
   */
  const tx = (id: string, day: string) =>
    event({
      event_id: id,
      source: "csv:accounting",
      event_type: "transaction",
      occurred_at: `2026-09-${day}T01:00:00.000Z`,
      metrics: { description: "A商店" },
    });

  const packet = buildStatePacket(
    input({
      baselines: [ESTABLISHED_INTERVAL, UNESTABLISHED_REVENUE],
      events: [
        event({
          event_id: "s1",
          occurred_at: "2026-09-07T01:00:00.000Z",
          metrics: { title: "定例" },
        }),
        tx("t1", "01"),
        tx("t2", "03"),
        tx("t3", "05"),
        tx("t4", "07"),
        tx("t5", "08"),
      ],
    }),
  );

  const state = (id: string) => packet.scans.find((s) => s.id === id)?.state.kind;

  it("走査1〜5 は回せない", () => {
    expect(state("deviation")).toBe("unavailable");
    expect(state("deadline")).toBe("unavailable");
    expect(state("external")).toBe("unavailable");
    expect(state("monitor")).toBe("unavailable");
    expect(state("worsening")).toBe("unavailable");
  });

  it("走査6〜8 は回せる", () => {
    expect(state("silence_company")).not.toBe("unavailable");
    expect(state("silence_series")).not.toBe("unavailable");
    expect(state("elongation_series")).not.toBe("unavailable");
  });

  it("乖離が回せない理由は、金額が無いこと（ベースラインの話に丸めない）", () => {
    const deviation = packet.scans.find((s) => s.id === "deviation");

    expect(deviation?.state).toEqual({
      kind: "unavailable",
      reason: "取引に金額（metrics.revenue）が1件も入っていない",
    });
  });
});
