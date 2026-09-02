import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConnectionOverview } from "@/lib/connections/overview";
import { ja } from "@/i18n/ja";

/**
 * 受入基準 H-1〜H-4。`/connect` の hydration mismatch（React error #418）の陰性コントロール。
 *
 * 本番で実測した形はこうだった（2026-08-27 / 08-28）:
 * `formatDate` が `toLocaleString` に `timeZone` を渡しておらず、
 * サーバ（Vercel = UTC）が `8月22日 17:18`、閲覧者のブラウザ（JST）が `8月23日 02:18` を描く。
 * 差はちょうど9時間で、同じ props から違う文字列が出るので React が hydration を諦める。
 *
 * `/report`（`src/app/report/report-view.tsx`）は `timeZone: "Asia/Tokyo"` を明示して
 * 同じ形を作らなかった。ここはその書き方に揃っていることを、**描画結果の文字列**で見る。
 */

const ORIGINAL_TZ = process.env.TZ;

// 実在しないアドレスに固定する（契約 停止点。実在の値をフィクスチャに書かない）
const FAKE_ACCOUNT_EMAIL = "nobody@example.invalid";

// 本番で壊れていた瞬間そのもの。UTC では 8/22 17:18、JST では 8/23 02:18
const KNOWN_ISO = "2026-08-22T17:18:00Z";

function overview(lastRefresh: string | null): ConnectionOverview {
  return {
    connections: [
      {
        provider: "google_calendar",
        status: "connected",
        last_refresh: lastRefresh,
        expires_at: null,
      },
    ],
    counts: { google_calendar: 3, "csv:accounting": 0, freee: 0 },
  };
}

/**
 * TZ を差し替えて、**モジュールを読み直してから**描く。
 *
 * `Intl.DateTimeFormat` をモジュールスコープに置くと、生成時点の既定タイムゾーンが固定される。
 * import 済みのまま `process.env.TZ` を変えても反映されないので、`resetModules` を挟まないと
 * **timeZone を消しても落ちない空洞のテスト**になる。ここが要点。
 */
async function renderUnderTz(tz: string, o: ConnectionOverview): Promise<string> {
  process.env.TZ = tz;
  vi.resetModules();
  const { ConnectClient } = await import("@/app/connect/connect-client");
  return renderToStaticMarkup(
    createElement(ConnectClient, {
      failureMessage: null,
      initialOverview: o,
      accountEmail: FAKE_ACCOUNT_EMAIL,
    siteUrl: null,
    }),
  );
}

afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
  vi.resetModules();
});

describe("H-1 陰性コントロール: TZ を変えても /connect の描画が1文字も変わらない", () => {
  it("TZ=UTC と TZ=Asia/Tokyo の描画結果が完全に一致する", async () => {
    const utc = await renderUnderTz("UTC", overview(KNOWN_ISO));
    const jst = await renderUnderTz("Asia/Tokyo", overview(KNOWN_ISO));

    expect(utc).toBe(jst);
  });

  it("サーバ側で起きうる他のTZでも一致する（UTCとJSTの2点だけでは日付跨ぎを見落とす）", async () => {
    const utc = await renderUnderTz("UTC", overview(KNOWN_ISO));

    for (const tz of ["America/Los_Angeles", "Europe/Berlin", "Pacific/Kiritimati"]) {
      expect(await renderUnderTz(tz, overview(KNOWN_ISO))).toBe(utc);
    }
  });
});

describe("H-2: 既知の ISO が JST として描かれる", () => {
  it("2026-08-22T17:18:00Z は JST の 8月23日 02:18 になる", async () => {
    const html = await renderUnderTz("UTC", overview(KNOWN_ISO));

    expect(html).toContain("8月23日");
    expect(html).toContain("02:18");
  });

  it("UTC のままの 8月22日 17:18 は描かれない", async () => {
    const html = await renderUnderTz("UTC", overview(KNOWN_ISO));

    expect(html).not.toContain("8月22日");
    expect(html).not.toContain("17:18");
  });

  it("最終同期のラベルと同じ行に出る", async () => {
    const html = await renderUnderTz("UTC", overview(KNOWN_ISO));

    expect(html).toContain(`${ja.connect.lastSync} 8月23日 02:18`);
  });
});

describe("H-3: last_refresh が null の行は既存どおり never を出す", () => {
  it("null は例外にせず t.connect.never を描く", async () => {
    const html = await renderUnderTz("Asia/Tokyo", overview(null));

    expect(html).toContain(`${ja.connect.lastSync} ${ja.connect.never}`);
  });

  it("null のとき日付らしき文字列を描かない", async () => {
    const html = await renderUnderTz("Asia/Tokyo", overview(null));

    expect(html).not.toContain("8月");
    expect(html).not.toContain("Invalid Date");
    expect(html).not.toContain("NaN");
  });

  it("null の行でも TZ による差が出ない", async () => {
    expect(await renderUnderTz("UTC", overview(null))).toBe(
      await renderUnderTz("Asia/Tokyo", overview(null)),
    );
  });
});

describe("H-4: /connect の描画結果に秘密が混ざらない", () => {
  it("照合用のアカウントアドレスは描画結果に出ない（比較にだけ使う）", async () => {
    const html = await renderUnderTz("Asia/Tokyo", overview(KNOWN_ISO));

    expect(html).not.toContain(FAKE_ACCOUNT_EMAIL);
    expect(html).not.toContain("example.invalid");
    expect(html).not.toContain("nobody");
  });

  it("生の ISO 文字列をそのまま描かない（整形した形だけを出す）", async () => {
    const html = await renderUnderTz("Asia/Tokyo", overview(KNOWN_ISO));

    expect(html).not.toContain(KNOWN_ISO);
    expect(html).not.toContain("2026-08-22");
  });

  it("トークンらしき語が描画結果に現れない", async () => {
    const html = await renderUnderTz("Asia/Tokyo", overview(KNOWN_ISO));

    for (const word of ["access_token", "refresh_token", "Bearer ", "eyJ"]) {
      expect(html).not.toContain(word);
    }
  });
});
