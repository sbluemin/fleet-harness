// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

// W2: router는 in-memory 상태를 사용하므로 URL 상태가 아닌 navigate/currentRoute 흐름으로 테스트한다.

describe("Codex router", () => {
  beforeEach(async () => {
    // 각 테스트마다 router/state 모듈을 재로드해 in-memory 상태를 초기화한다.
    const { destroyRouter, initRouter } = await import("../core/client/src/codex/router");
    destroyRouter();
    initRouter();
    // state의 currentWorkspaceId도 리셋
    const { setCurrentWorkspaceId } = await import("../core/client/src/codex/state");
    setCurrentWorkspaceId(null);
  });

  it("starts at home route", async () => {
    const { currentRoute } = await import("../core/client/src/codex/router");

    expect(currentRoute()).toEqual({ name: "home" });
  });

  it("parses entry routes via navigate", async () => {
    const { navigate, currentRoute } = await import("../core/client/src/codex/router");

    navigate("/entry/guide-001");

    expect(currentRoute()).toEqual({ name: "entry", id: "guide-001" });
  });

  it("parses workspace entry routes via navigate", async () => {
    const { navigate, currentRoute } = await import("../core/client/src/codex/router");

    navigate("/w/ws-a/entry/shared");

    expect(currentRoute()).toEqual({ name: "entry", id: "shared" });
  });

  it("emits the parsed route after navigate without changing the URL", async () => {
    const { navigate, subscribeRoute } = await import("../core/client/src/codex/router");
    const seen: unknown[] = [];
    const unsubscribe = subscribeRoute((route) => seen.push(route));
    const urlBefore = location.pathname;

    navigate("/entry/guide-002");

    unsubscribe();
    expect(location.pathname).toBe(urlBefore);
    expect(seen).toEqual([{ name: "entry", id: "guide-002" }]);
  });

  it("parses Full route URL (/console/codex/...) via navigate", async () => {
    const { navigate, currentRoute } = await import("../core/client/src/codex/router");

    navigate("/console/codex/entry/guide-003");

    expect(currentRoute()).toEqual({ name: "entry", id: "guide-003" });
  });

  it("builds workspace-scoped paths when currentWorkspaceId is set", async () => {
    const { setCurrentWorkspaceId } = await import("../core/client/src/codex/state");
    const { entryPath, homePath } = await import("../core/client/src/codex/router");

    setCurrentWorkspaceId("ws-a");

    expect(homePath()).toBe("/w/ws-a/");
    expect(entryPath("guide-003")).toBe("/w/ws-a/entry/guide-003");
  });

  it("builds bare paths when currentWorkspaceId is null", async () => {
    const { entryPath, homePath } = await import("../core/client/src/codex/router");

    expect(homePath()).toBe("/");
    expect(entryPath("guide-003")).toBe("/entry/guide-003");
  });
});
