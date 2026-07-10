import { describe, expect, it, vi } from "vitest";

import { createTheaterPathContextRouter } from "../core/host/theater-path-context-routes.js";

describe("Theater path-context routes", () => {
  it("rejects a mutation before it can persist when payload is malformed", async () => {
    const persist = vi.fn();
    const writeJson = vi.fn();
    const router = createTheaterPathContextRouter({
      getTheater: () => ({ id: "theater", path: "/tmp", realpath: "/tmp", label: "tmp", registeredAt: "1", lastOpenedAt: "1", pathContext: null }),
      isAuthorized: () => true,
      persist,
      readJsonBody: async <T>() => ({ relPath: "../escape" } as T),
      setPathContext: vi.fn(),
      writeJson,
    });
    await router({ req: { method: "PUT" } as never, res: {} as never, pathname: "/api/v1/theaters/theater/path-context" });
    expect(persist).not.toHaveBeenCalled();
    expect(writeJson).toHaveBeenLastCalledWith(expect.anything(), 400, { error: "invalid_path" });
  });

  it("uses origin authorization for writes and directory expansion", async () => {
    const writeJson = vi.fn();
    const router = createTheaterPathContextRouter({
      getTheater: () => ({ id: "theater", path: "/tmp", realpath: "/tmp", label: "tmp", registeredAt: "1", lastOpenedAt: "1", pathContext: null }),
      isAuthorized: () => false,
      persist: vi.fn(),
      readJsonBody: async <T>() => ({ relativePath: null } as T),
      setPathContext: vi.fn(),
      writeJson,
    });
    await router({ req: { method: "POST" } as never, res: {} as never, pathname: "/api/v1/theaters/theater/path-context/directories" });
    expect(writeJson).toHaveBeenLastCalledWith(expect.anything(), 401, { error: "unauthorized" });
  });

  it("heals a vanished stored context to root on read instead of failing", async () => {
    const persist = vi.fn();
    const writeJson = vi.fn();
    const theater = { id: "theater", path: "/tmp", realpath: "/tmp", label: "tmp", registeredAt: "1", lastOpenedAt: "1", pathContext: "gone-worktree" };
    const setPathContext = vi.fn(() => ({ ...theater, pathContext: null }));
    const router = createTheaterPathContextRouter({
      getTheater: () => theater,
      isAuthorized: () => true,
      persist,
      readJsonBody: async <T>() => ({} as T),
      setPathContext,
      writeJson,
    });
    await router({ req: { method: "GET" } as never, res: {} as never, pathname: "/api/v1/theaters/theater/path-context" });
    expect(setPathContext).toHaveBeenCalledWith("theater", null);
    expect(persist).toHaveBeenCalled();
    expect(writeJson).toHaveBeenLastCalledWith(expect.anything(), 200, expect.objectContaining({ kind: "root", relPath: null }));
  });
});
