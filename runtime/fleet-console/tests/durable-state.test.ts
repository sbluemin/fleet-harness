import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createConsoleDurableStateStore,
  sanitizeDurableConsoleState,
} from "../core/host/durable-state.js";
import type { ConsoleDataPaths } from "../core/host/paths.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("durable console state", () => {
  it("falls back to an empty state for version mismatch or malformed data", () => {
    expect(sanitizeDurableConsoleState({ version: 1, theaters: [], operations: [] })).toEqual({ version: 2, theaters: [], operations: [], groups: [] });
    expect(sanitizeDurableConsoleState({ version: 2, theaters: [{ id: "" }], operations: [{ id: "" }] })).toEqual({ version: 2, theaters: [], operations: [], groups: [] });
  });

  it("remaps persisted terminal plugin ids without changing operation type or id", () => {
    const sanitized = sanitizeDurableConsoleState({
      version: 2,
      theaters: [],
      operations: [
        makeOperationNode({ id: "agent-op", pluginId: "agent", type: "agent" }),
        makeOperationNode({ id: "shell-op", pluginId: "shell", type: "shell" }),
        makeOperationNode({ id: "demo-op", pluginId: "demo", type: "demo" }),
      ],
    });

    expect(sanitized.operations.map((operation) => ({
      id: operation.id,
      pluginId: operation.pluginId,
      type: operation.type,
    }))).toEqual([
      { id: "agent-op", pluginId: "terminal", type: "agent" },
      { id: "shell-op", pluginId: "terminal", type: "shell" },
      { id: "demo-op", pluginId: "demo", type: "demo" },
    ]);
  });

  it("creates the state store with sensitive durable JSON settings", () => {
    let received: unknown;
    const paths: ConsoleDataPaths = {
      dir: "/tmp/fleet/console",
      stateFile: "/tmp/fleet/console/state.json",
      capturesDir: "/tmp/fleet/console/captures",
    };

    const store = createConsoleDurableStateStore({
      paths,
      createStore: (deps) => {
        received = deps;
        return {
          path: deps.filePath,
          load: () => deps.sanitize(undefined),
          save: () => undefined,
          update: (mutate) => mutate(deps.sanitize(undefined)),
        };
      },
    });

    expect(store.path).toBe(paths.stateFile);
    expect(received).toMatchObject({
      filePath: paths.stateFile,
      lockDir: path.join(paths.dir, "state.lock"),
      sensitivity: "sensitive",
      tempCleanupPrefix: ".state.",
    });
  });

});

function makeOperationNode(input: { readonly id: string; readonly pluginId: string; readonly type: string }) {
  return {
    id: input.id,
    theaterId: "theater",
    type: input.type,
    pluginId: input.pluginId,
    title: input.id,
    payload: {},
    geometry: null,
    state: {},
    ts: { createdAt: 1, updatedAt: 1 },
  };
}
