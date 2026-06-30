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
    expect(sanitizeDurableConsoleState({ version: 3, theaters: [], operations: [] })).toEqual({ version: 2, theaters: [], operations: [], operationNodes: [], groups: [] });
    expect(sanitizeDurableConsoleState({ version: 2, theaters: [{ id: "" }], operations: [{ sessionId: "missing" }], operationNodes: [{ id: "" }] })).toEqual({ version: 2, theaters: [], operations: [], operationNodes: [], groups: [] });
  });

  it("migrates v1 durable operations into v2 OperationNodes one-way", () => {
    const migrated = sanitizeDurableConsoleState({
      version: 1,
      theaters: [],
      operations: [{
        sessionId: "session-a",
        theaterId: "theater-a",
        cwd: "/secret/project",
        cwdLabel: "project",
        sequence: 1,
        label: "Bridge Watch",
        cliId: "claude",
        cliLabel: "Claude",
        createdAt: 1,
      }],
    });

    expect(migrated.version).toBe(2);
    expect(migrated.operationNodes[0]).toMatchObject({
      id: "session-a",
      theaterId: "theater-a",
      type: "shell",
      pluginId: "terminal",
      title: "Bridge Watch",
    });
  });

  it("remaps persisted terminal plugin ids without changing operation type or id", () => {
    const sanitized = sanitizeDurableConsoleState({
      version: 2,
      theaters: [],
      operations: [],
      operationNodes: [
        makeOperationNode({ id: "agent-op", pluginId: "agent", type: "agent" }),
        makeOperationNode({ id: "shell-op", pluginId: "shell", type: "shell" }),
        makeOperationNode({ id: "demo-op", pluginId: "demo", type: "demo" }),
      ],
    });

    expect(sanitized.operationNodes.map((operation) => ({
      id: operation.id,
      pluginId: operation.pluginId,
      type: operation.type,
    }))).toEqual([
      { id: "agent-op", pluginId: "terminal", type: "agent" },
      { id: "shell-op", pluginId: "terminal", type: "shell" },
      { id: "demo-op", pluginId: "demo", type: "demo" },
    ]);
  });

  it("preserves valid auto-name metadata and drops malformed values without dropping the operation", () => {
    const base = { sessionId: "s", theaterId: "t", cwd: "/p", cwdLabel: "p", sequence: 1, createdAt: 1 };
    const sanitized = sanitizeDurableConsoleState({
      version: 1,
      theaters: [],
      operations: [
        { ...base, sessionId: "user-op", label: "Bridge Watch", labelSource: "user" },
        { ...base, sessionId: "auto-op", label: "Fix the parser", labelSource: "auto", autoNamePromptSeen: true },
        { ...base, sessionId: "legacy-auto-op", label: "Existing auto label", labelSource: "auto" },
        { ...base, sessionId: "legacy-op", label: "Legacy label" },
        { ...base, sessionId: "bad-op", label: "Bad source", labelSource: "operator", autoNamePromptSeen: "yes" },
      ],
    });

    const bySession = Object.fromEntries(sanitized.operations.map((operation) => [operation.sessionId, operation]));
    expect(bySession["user-op"]?.labelSource).toBe("user");
    expect(bySession["auto-op"]?.labelSource).toBe("auto");
    expect(bySession["auto-op"]?.autoNamePromptSeen).toBe(true);
    // 기존 자동 작명 Operation은 marker가 없더라도 이미 최초 prompt가 처리된 것으로 보수 backfill한다.
    expect(bySession["legacy-auto-op"]?.autoNamePromptSeen).toBe(true);
    // 레거시(labelSource 없는) Operation은 그대로 보존되며 labelSource는 undefined로 남는다(read-time에 user로 해석).
    expect(bySession["legacy-op"]).toBeDefined();
    expect(bySession["legacy-op"]?.labelSource).toBeUndefined();
    // 잘못된 metadata는 필드만 떨궈지고 Operation 자체는 유지된다.
    expect(bySession["bad-op"]?.label).toBe("Bad source");
    expect(bySession["bad-op"]?.labelSource).toBeUndefined();
    expect(bySession["bad-op"]?.autoNamePromptSeen).toBeUndefined();
  });

  it("sanitizes durable operation accents as optional trimmed short strings", () => {
    const base = { sessionId: "s", theaterId: "t", cwd: "/p", cwdLabel: "p", sequence: 1, createdAt: 1 };
    const sanitized = sanitizeDurableConsoleState({
      version: 1,
      theaters: [],
      operations: [
        { ...base, sessionId: "accent-op", accent: "  blue  " },
        { ...base, sessionId: "long-accent-op", accent: "x".repeat(80) },
        { ...base, sessionId: "blank-accent-op", accent: "   " },
        { ...base, sessionId: "bad-accent-op", accent: 12 },
      ],
    });

    const bySession = Object.fromEntries(sanitized.operations.map((operation) => [operation.sessionId, operation]));
    expect(bySession["accent-op"]?.accent).toBe("blue");
    expect(bySession["long-accent-op"]?.accent).toHaveLength(64);
    expect(bySession["blank-accent-op"]?.accent).toBeUndefined();
    expect(bySession["bad-accent-op"]?.accent).toBeUndefined();
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
    parentId: null,
    type: input.type,
    pluginId: input.pluginId,
    title: input.id,
    payload: {},
    geometry: null,
    state: {},
    ts: { createdAt: 1, updatedAt: 1 },
  };
}
