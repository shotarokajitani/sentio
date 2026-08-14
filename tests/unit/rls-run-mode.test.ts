import { describe, it, expect } from "vitest";
import { resolveRlsRunMode } from "../helpers/rls-run-mode";

// このガード自体が壊れると、RLS検証がCIで静かにskipされる状態に戻る。
// ガードの分岐を直接固定する。
describe("resolveRlsRunMode — RLS統合テストのfail-openガード", () => {
  it("鍵が揃っていれば実行する", () => {
    expect(resolveRlsRunMode({ ci: false, anonKey: "a", serviceKey: "s" })).toBe("run");
    expect(resolveRlsRunMode({ ci: true, anonKey: "a", serviceKey: "s" })).toBe("run");
  });

  it("CIで鍵が欠けていたら失敗させる（skipにしない）", () => {
    expect(resolveRlsRunMode({ ci: true, anonKey: undefined, serviceKey: undefined })).toBe("fail");
    expect(resolveRlsRunMode({ ci: true, anonKey: "a", serviceKey: undefined })).toBe("fail");
    expect(resolveRlsRunMode({ ci: true, anonKey: undefined, serviceKey: "s" })).toBe("fail");
  });

  it("空文字は「未設定」として扱う", () => {
    expect(resolveRlsRunMode({ ci: true, anonKey: "", serviceKey: "" })).toBe("fail");
    expect(resolveRlsRunMode({ ci: false, anonKey: "", serviceKey: "s" })).toBe("skip");
  });

  it("ローカル（CI以外）で鍵が欠けていればskipしてよい", () => {
    expect(resolveRlsRunMode({ ci: false, anonKey: undefined, serviceKey: undefined })).toBe(
      "skip",
    );
  });
});
