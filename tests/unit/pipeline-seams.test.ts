import { describe, it, expect } from "vitest";
import { resolveDeliveryIntent } from "@edge/_shared/delivery.ts";
import {
  DEFAULT_INVESTIGATE_FUNCTION,
  resolveInvestigateFunction,
  resolveInvestigateUrl,
} from "@edge/_shared/investigate-url.ts";
import type { ResolvedCaller } from "@edge/_shared/caller.ts";

/**
 * S-3 の2つの継ぎ目（seam）を、Docker 無しで固定する。
 *
 * どちらも「CI で一気通貫を通すために本番の既定挙動を変えない」ことが要件であり、
 * **env や呼び出し元が想定外のときに緩い側へ倒れない**ことがこのテストの主眼である。
 * 契約 S-3-1。本番コードに `if (testMode)` を作らない方針の担保でもある。
 */

const internal: ResolvedCaller = { kind: "internal", companyId: null };
const user: ResolvedCaller = { kind: "user", companyId: "u-1" };

describe("resolveDeliveryIntent — 送信を止める意思は internal からしか受けない", () => {
  it("internal が defer を指定したら defer になる", () => {
    expect(resolveDeliveryIntent(internal, "defer")).toBe("defer");
  });

  it("internal でも指定が無ければ send（既定は送る側のまま変えない）", () => {
    expect(resolveDeliveryIntent(internal, undefined)).toBe("send");
  });

  // 陰性コントロール（必須）。ここが漏れると外部から「送ったつもり」を作れる
  it("user が defer を指定しても採用されず send になる", () => {
    expect(resolveDeliveryIntent(user, "defer")).toBe("send");
  });

  it("internal が未知の値を渡しても defer に化けない", () => {
    expect(resolveDeliveryIntent(internal, "DEFER")).toBe("send");
    expect(resolveDeliveryIntent(internal, "")).toBe("send");
    expect(resolveDeliveryIntent(internal, "send")).toBe("send");
  });

  it("user が send を指定した場合も send", () => {
    expect(resolveDeliveryIntent(user, "send")).toBe("send");
  });
});

describe("resolveInvestigateUrl — env 未設定なら本番の既定に倒れる", () => {
  const self = "http://kong:8000";
  const real = "http://kong:8000/functions/v1/investigate";

  // 陰性コントロール（必須）。env が無いときにスタブへ落ちる実装は fail-open
  it("env が未設定なら本番の investigate を指す", () => {
    expect(resolveInvestigateUrl(() => undefined, self)).toBe(real);
    expect(resolveInvestigateFunction(() => undefined)).toBe(DEFAULT_INVESTIGATE_FUNCTION);
  });

  it("空文字・空白のみは未設定として扱う", () => {
    expect(resolveInvestigateUrl(() => "", self)).toBe(real);
    expect(resolveInvestigateUrl(() => "   ", self)).toBe(real);
  });

  it("env が設定されていればその Function を指す", () => {
    expect(resolveInvestigateUrl(() => "investigate-stub", self)).toBe(
      "http://kong:8000/functions/v1/investigate-stub",
    );
  });

  it("前後の空白は落とす", () => {
    expect(resolveInvestigateFunction(() => "  investigate-stub  ")).toBe("investigate-stub");
  });

  // 陰性コントロール。名前だけを受けるので、env が汚染されても
  // 候補（会社の状態）を外部ホストへ送り出す宛先には化けない
  it("URL や経路区切りを含む値は既定に倒す", () => {
    const bad = [
      "http://evil.example/x",
      "../../secret",
      "investigate/../../x",
      "INVESTIGATE",
      "-leading-hyphen",
      "has space",
      "semi;colon",
    ];
    for (const value of bad) {
      expect(
        resolveInvestigateFunction(() => value),
        value,
      ).toBe(DEFAULT_INVESTIGATE_FUNCTION);
      expect(
        resolveInvestigateUrl(() => value, self),
        value,
      ).toBe(real);
    }
  });
});
