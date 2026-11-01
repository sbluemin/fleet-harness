import { expect, it } from "vitest";

import { parseToolShellKey, toolShellKey } from "../../features/execution/shared/shell-key.js";

// 도구 Shell 키 — (사령관, Theater)마다 하나. 서버는 불투명 문자열로 다루고,
// 입장 허가만 앞부분을 읽는다.

it("round-trips commodore and theater through the key", () => {
  const key = toolShellKey("c1", "t1");
  expect(key).toBe("tool-shell:commodore:c1:theater:t1");
  expect(parseToolShellKey(key!)).toEqual({ commodoreId: "c1", theaterId: "t1" });
});

it("rejects keys that do not carry a tool shell", () => {
  expect(parseToolShellKey("console")).toBeNull();
  expect(parseToolShellKey("session:commodore:commodore:c1")).toBeNull();
  expect(parseToolShellKey("tool-shell:commodore:c1")).toBeNull();
  expect(parseToolShellKey("")).toBeNull();
});

it("refuses control characters and empty segments", () => {
  expect(toolShellKey("", "t1")).toBeNull();
  expect(toolShellKey("c1", "")).toBeNull();
  expect(toolShellKey("c1\n", "t1")).toBeNull();
  expect(toolShellKey("c1", "t\0e")).toBeNull();
});
