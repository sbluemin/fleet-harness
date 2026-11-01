import { expect, it } from "vitest";

import {
  resolveCommodoreToolTheater,
  shouldSuppressCommodoreToolFileOpen,
} from "../features/workspace/shared/commodore-tool-theater.js";

// 사령관 전용 도구의 Theater 판정 — 영속 스위트에 남기는 것은 실측된 막다른 길(등록 Theater를
// 해제해도 도구가 열리지 않던 일)의 계약뿐이다. 그 밖의 분기는 도우미의 옮겨 적기가 된다.

it("falls back to the first remaining Theater when the stored one was removed", () => {
  expect(resolveCommodoreToolTheater("gone", [
    { theaterId: "t1", status: "available" },
    { theaterId: "t2", status: "available" },
  ])).toEqual({ kind: "resolved", theaterId: "t1" });
});

it("reports no Theater when the last one was removed", () => {
  expect(resolveCommodoreToolTheater("gone", [])).toEqual({ kind: "none" });
  expect(resolveCommodoreToolTheater(null, [])).toEqual({ kind: "none" });
});

it("suppresses only chat file links from objective conversations", () => {
  expect(shouldSuppressCommodoreToolFileOpen({ source: "agent-chat", objectiveId: "o1" })).toBe(true);
  expect(shouldSuppressCommodoreToolFileOpen({ source: "agent-chat" })).toBe(false);
  expect(shouldSuppressCommodoreToolFileOpen({ source: "files", objectiveId: "o1" })).toBe(false);
  expect(shouldSuppressCommodoreToolFileOpen({ source: "agent-terminal", objectiveId: "o1" })).toBe(false);
  expect(shouldSuppressCommodoreToolFileOpen({ source: "palette" })).toBe(false);
});
