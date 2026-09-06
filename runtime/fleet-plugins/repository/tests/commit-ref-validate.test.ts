import { describe, expect, it } from "vitest";

import { REF_RE } from "../server/commit.js";

describe("commit ref 검증 정규식", () => {
  it("7자 short hash를 허용한다", () => {
    expect(REF_RE.test("abc1234")).toBe(true);
  });

  it("HEAD를 거부한다", () => {
    expect(REF_RE.test("HEAD")).toBe(false);
  });

  it("경로 이탈 시도를 거부한다", () => {
    expect(REF_RE.test("../etc/passwd")).toBe(false);
    expect(REF_RE.test("--help")).toBe(false);
  });
});
