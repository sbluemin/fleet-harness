import { describe, expect, it } from "vitest";

import { consoleRoutePrefixOf } from "../core/host/plugin-host/plugin-host.js";

/**
 * `/console/<prefix>` 한 칸을 선언한 플러그인에만 내준다.
 *
 * 사용자가 주고받는 링크를 가진 표면은 `/plugins/<id>` 안에 살 수 없다 — 주소가
 * 구현 위치를 드러내고, 플러그인을 옮기면 이미 공유된 링크가 전부 깨진다.
 */
describe("plugin console route prefix", () => {
  it("grants one segment to a plugin that declares it", () => {
    expect(consoleRoutePrefixOf({ consoleRoutePrefix: "codex" })).toBe("/console/codex");
    expect(consoleRoutePrefixOf({ consoleRoutePrefix: "/codex/" })).toBe("/console/codex");
  });

  it("grants nothing when the plugin does not ask", () => {
    expect(consoleRoutePrefixOf({})).toBeNull();
    expect(consoleRoutePrefixOf({ consoleRoutePrefix: 42 })).toBeNull();
  });

  it("refuses a nested prefix so a plugin cannot burrow under a core screen", () => {
    // `/console/operations/x`를 허용하면 플러그인이 코어 화면 아래로 파고든다.
    expect(consoleRoutePrefixOf({ consoleRoutePrefix: "operations/x" })).toBeNull();
    expect(consoleRoutePrefixOf({ consoleRoutePrefix: "a/b" })).toBeNull();
  });

  it("refuses traversal and empty declarations", () => {
    expect(consoleRoutePrefixOf({ consoleRoutePrefix: ".." })).toBeNull();
    expect(consoleRoutePrefixOf({ consoleRoutePrefix: "" })).toBeNull();
    expect(consoleRoutePrefixOf({ consoleRoutePrefix: "   " })).toBeNull();
  });

  it("refuses characters that would not survive a URL round trip", () => {
    expect(consoleRoutePrefixOf({ consoleRoutePrefix: "Codex" })).toBeNull();
    expect(consoleRoutePrefixOf({ consoleRoutePrefix: "co dex" })).toBeNull();
    expect(consoleRoutePrefixOf({ consoleRoutePrefix: "-codex" })).toBeNull();
  });
});
