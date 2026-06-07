import { describe, expect, it } from "vitest";

import { escapeTomlMultilineString } from "../../src/agent-cli/builders/toml.js";

// escapeTomlMultilineString는 doctrine을 TOML 멀티라인 basic string("""...""") 본문에
// 안전하게 담으면서 줄바꿈은 리터럴로 보존(pretty)해야 한다.
describe("escapeTomlMultilineString", () => {
  it("줄바꿈과 탭은 리터럴로 보존한다", () => {
    expect(escapeTomlMultilineString("line1\nline2\tend")).toBe("line1\nline2\tend");
  });

  it("백슬래시를 이스케이프한다", () => {
    expect(escapeTomlMultilineString("a\\b")).toBe("a\\\\b");
  });

  it("CR과 그 외 제어문자, NUL/DEL은 \\uXXXX로 이스케이프한다", () => {
    expect(escapeTomlMultilineString("a\rb")).toBe("a\\u000db");
    expect(escapeTomlMultilineString("a\x00b")).toBe("a\\u0000b");
    expect(escapeTomlMultilineString("a\x7fb")).toBe("a\\u007fb");
    expect(escapeTomlMultilineString("a\x1bb")).toBe("a\\u001bb");
  });

  it("3개 이상 연속 따옴표는 종료 구분자와 충돌하지 않도록 모두 이스케이프한다", () => {
    expect(escapeTomlMultilineString('a"""b')).toBe('a\\"\\"\\"b');
    expect(escapeTomlMultilineString('a""""b')).toBe('a\\"\\"\\"\\"b');
  });

  it("중간의 1~2개 연속 따옴표는 그대로 둔다", () => {
    expect(escapeTomlMultilineString('a"b')).toBe('a"b');
    expect(escapeTomlMultilineString('a""b')).toBe('a""b');
  });

  it("문자열 끝의 따옴표는 닫는 \"\"\" 앞 모호성을 피하려고 이스케이프한다", () => {
    expect(escapeTomlMultilineString('ab"')).toBe('ab\\"');
    expect(escapeTomlMultilineString('ab""')).toBe('ab\\"\\"');
  });

  it("특수 문자가 없으면 원문을 그대로 반환한다", () => {
    expect(escapeTomlMultilineString("private fleet prompt")).toBe("private fleet prompt");
  });
});
