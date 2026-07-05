import { describe, expect, it } from "vitest";

// ref 검증 정규식: commit.ts의 REF_RE와 동일 계약
const REF_RE = /^[0-9a-f]{7,40}$/i;

describe("commit ref 검증 정규식", () => {
  it("7자 short hash를 허용한다", () => {
    expect(REF_RE.test("abc1234")).toBe(true);
  });

  it("40자 full hash를 허용한다", () => {
    expect(REF_RE.test("abc1234def5678abc1234def5678abc1234def56")).toBe(true);
  });

  it("대소문자 혼합 hex를 허용한다", () => {
    expect(REF_RE.test("ABC1234")).toBe(true);
    expect(REF_RE.test("AbCdEf1")).toBe(true);
  });

  it("6자 이하(너무 짧음)를 거부한다", () => {
    expect(REF_RE.test("abc123")).toBe(false);
    expect(REF_RE.test("abc")).toBe(false);
  });

  it("41자 이상(너무 긴 hex)을 거부한다", () => {
    expect(REF_RE.test("abc1234def5678abc1234def5678abc1234def567")).toBe(false);
  });

  it("HEAD를 거부한다", () => {
    expect(REF_RE.test("HEAD")).toBe(false);
  });

  it("브랜치명(main, feature/foo)을 거부한다", () => {
    expect(REF_RE.test("main")).toBe(false);
    expect(REF_RE.test("feature/foo")).toBe(false);
  });

  it("태그명(v1.0.0)을 거부한다", () => {
    expect(REF_RE.test("v1.0.0")).toBe(false);
  });

  it("경로 이탈 시도를 거부한다", () => {
    expect(REF_RE.test("../etc/passwd")).toBe(false);
    expect(REF_RE.test("--help")).toBe(false);
  });

  it("공백 포함 값을 거부한다", () => {
    expect(REF_RE.test("abc1234 --something")).toBe(false);
  });

  it("빈 문자열을 거부한다", () => {
    expect(REF_RE.test("")).toBe(false);
  });

  it("hex 이외 문자 포함을 거부한다", () => {
    expect(REF_RE.test("xyz1234")).toBe(false);
    expect(REF_RE.test("abc1234g")).toBe(false);
  });
});
