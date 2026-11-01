import { expect, it } from "vitest";

import {
  resolveCommodoreToolTheater,
  shouldSuppressCommodoreToolFileOpen,
} from "../features/workspace/shared/commodore-tool-theater.js";

// (사령관, 도구)의 Theater 판정 — 다른 Theater의 파일·Shell을 건드리는 일은 이 판정에서 막는다.
// 등록에 없는 값은 절대 돌려주지 않는다.

it("returns none when no Theater is registered", () => {
  expect(resolveCommodoreToolTheater(null, [])).toEqual({ kind: "none" });
  expect(resolveCommodoreToolTheater("t1", [])).toEqual({ kind: "none" });
});

it("returns none when every registered Theater is missing", () => {
  expect(resolveCommodoreToolTheater(null, [
    { theaterId: "t1", status: "missing" },
    { theaterId: "t2", status: "missing" },
  ])).toEqual({ kind: "none" });
});

it("keeps the stored Theater while it is still available", () => {
  expect(resolveCommodoreToolTheater("t2", [
    { theaterId: "t1", status: "available" },
    { theaterId: "t2", status: "available" },
  ])).toEqual({ kind: "resolved", theaterId: "t2" });
});

it("falls back to the first available Theater on first open", () => {
  expect(resolveCommodoreToolTheater(null, [
    { theaterId: "t1", status: "available" },
    { theaterId: "t2", status: "available" },
  ])).toEqual({ kind: "resolved", theaterId: "t1" });
});

it("skips missing Theaters when falling back", () => {
  expect(resolveCommodoreToolTheater(null, [
    { theaterId: "t1", status: "missing" },
    { theaterId: "t2", status: "available" },
  ])).toEqual({ kind: "resolved", theaterId: "t2" });
});

it("falls back to the first remaining Theater when the stored one was removed", () => {
  expect(resolveCommodoreToolTheater("gone", [
    { theaterId: "t1", status: "available" },
    { theaterId: "t2", status: "available" },
  ])).toEqual({ kind: "resolved", theaterId: "t1" });
});

it("asks to choose when the stored Theater vanished but stays registered", () => {
  expect(resolveCommodoreToolTheater("t1", [
    { theaterId: "t1", status: "missing" },
    { theaterId: "t2", status: "available" },
  ])).toEqual({ kind: "choose", theaterId: "t1" });
});

it("never resolves to an unregistered Theater", () => {
  const resolution = resolveCommodoreToolTheater("attacker-theater", [
    { theaterId: "t1", status: "available" },
  ]);
  expect(resolution).toEqual({ kind: "resolved", theaterId: "t1" });
});

it("suppresses only chat file links from objective conversations", () => {
  expect(shouldSuppressCommodoreToolFileOpen({ source: "agent-chat", objectiveId: "o1" })).toBe(true);
  expect(shouldSuppressCommodoreToolFileOpen({ source: "agent-chat" })).toBe(false);
  expect(shouldSuppressCommodoreToolFileOpen({ source: "files", objectiveId: "o1" })).toBe(false);
  expect(shouldSuppressCommodoreToolFileOpen({ source: "agent-terminal", objectiveId: "o1" })).toBe(false);
  expect(shouldSuppressCommodoreToolFileOpen({ source: "palette" })).toBe(false);
});
