import { describe, expect, it } from "vitest";

import { isSafeCompareRef } from "../server/compare.js";

describe("isSafeCompareRef", () => {
  it.each([
    ["리터럴 HEAD", "HEAD"],
    ["hex short SHA", "abc1234"],
    ["hex full SHA", "abc1234def5678abc1234def5678abc1234def56"],
    ["로컬 브랜치 풀 refname", "refs/heads/feature/x"],
    ["리모트 풀 refname", "refs/remotes/origin/main"],
    ["태그 풀 refname", "refs/tags/v1.0"],
  ])("%s를 허용한다", (_label, value) => {
    expect(isSafeCompareRef(value)).toBe(true);
  });

  it.each([
    ["leading dash", "-rev"],
    ["옵션 주입", "--output=x"],
    ["bare shortname", "main"],
    ["range 문법 `..`", "refs/heads/a..b"],
    ["공백 포함", "refs/heads/a b"],
    ["reflog 문법 @{", "@{u}"],
    ["refname 내부 @{", "refs/heads/a@{1}"],
    ["빈 문자열", ""],
    ["말미 슬래시", "refs/heads/"],
    [".lock 말미 컴포넌트", "refs/heads/a.lock"],
    ["`.` 시작 컴포넌트", "refs/heads/.hidden"],
    ["백슬래시", "refs/heads/a\\b"],
    ["틸드", "refs/heads/a~1"],
    ["캐럿", "refs/heads/a^2"],
    ["콜론", "refs/heads/a:b"],
    ["글롭 ?", "refs/heads/a?"],
    ["글롭 *", "refs/heads/a*"],
    ["글롭 [", "refs/heads/a[b"],
    ["제어문자", "refs/heads/a\tb"],
    ["이중 슬래시", "refs/heads//a"],
    ["말미 `.`", "refs/heads/a."],
    ["소문자 head", "head"],
    ["비허용 프리픽스", "refs/stash"],
  ])("%s(%s)를 거부한다", (_label, value) => {
    expect(isSafeCompareRef(value)).toBe(false);
  });
});
