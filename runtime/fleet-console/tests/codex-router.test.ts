// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

describe("Codex router", () => {
  beforeEach(() => {
    vi.resetModules();
    history.replaceState(null, "", "/");
  });

  it("parses console-mounted entry routes", async () => {
    history.replaceState(null, "", "/console/codex/entry/guide-001");
    const { currentRoute, currentWorkspaceId } = await import("../core/client/src/codex/router");

    expect(currentRoute()).toEqual({ name: "entry", id: "guide-001" });
    expect(currentWorkspaceId()).toBeNull();
  });

  it("parses console-mounted workspace entry routes", async () => {
    history.replaceState(null, "", "/console/codex/w/ws-a/entry/shared");
    const { currentRoute, currentWorkspaceId } = await import("../core/client/src/codex/router");

    expect(currentRoute()).toEqual({ name: "entry", id: "shared" });
    expect(currentWorkspaceId()).toBe("ws-a");
  });

  it("emits the parsed route after pushState navigation", async () => {
    history.replaceState(null, "", "/console/codex/");
    const { navigate, subscribeRoute } = await import("../core/client/src/codex/router");
    const seen: unknown[] = [];
    const unsubscribe = subscribeRoute((route) => seen.push(route));

    navigate("/console/codex/entry/guide-002");

    unsubscribe();
    expect(location.pathname).toBe("/console/codex/entry/guide-002");
    expect(seen).toEqual([{ name: "entry", id: "guide-002" }]);
  });

  it("keeps generated entry paths under the console Codex mount", async () => {
    history.replaceState(null, "", "/console/codex/");
    const { entryPath, homePath } = await import("../core/client/src/codex/router");

    expect(homePath()).toBe("/console/codex/");
    expect(entryPath("guide-003")).toBe("/console/codex/entry/guide-003");
  });

  it("builds workspace home paths under the console Codex mount", async () => {
    const { workspaceHomePath } = await import("../core/client/src/codex/router");

    expect(workspaceHomePath("ws-a")).toBe("/console/codex/w/ws-a/");
  });
});
