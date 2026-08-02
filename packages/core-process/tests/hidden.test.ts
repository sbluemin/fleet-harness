import { describe, expect, it } from "vitest";

import { withHidden } from "../src/bin-resolver.js";

describe("withHidden", () => {
  it("빈 인자 호출 시 windowsHide:true 반환", () => {
    expect(withHidden()).toEqual({ windowsHide: true });
  });

  it("기존 옵션과 병합", () => {
    expect(withHidden({ cwd: "/x", stdio: "pipe" })).toEqual({ cwd: "/x", stdio: "pipe", windowsHide: true });
  });

  it("명시적 windowsHide:false는 true로 override", () => {
    expect(withHidden({ windowsHide: false })).toEqual({ windowsHide: true });
  });

  it("원본 객체를 변경하지 않음(shallow copy)", () => {
    const opts = { cwd: "/x" };
    const result = withHidden(opts);
    expect(result).not.toBe(opts);
    expect(opts).not.toHaveProperty("windowsHide");
  });
});
