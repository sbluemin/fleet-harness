import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createConsoleDurableStateStore,
  cleanupProviderSessionCaptures,
  mergeProviderSessionCaptures,
  readProviderSessionCapture,
  sanitizeDurableConsoleState,
  unlinkProviderSessionCapture,
  type DurableConsoleState,
} from "../src/durable-state.js";
import type { ConsoleDataPaths } from "../src/paths.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("durable console state", () => {
  it("falls back to an empty state for version mismatch or malformed data", () => {
    expect(sanitizeDurableConsoleState({ version: 2, theaters: [], operations: [] })).toEqual({ version: 1, theaters: [], operations: [] });
    expect(sanitizeDurableConsoleState({ version: 1, theaters: [{ id: "" }], operations: [{ sessionId: "missing" }] })).toEqual({ version: 1, theaters: [], operations: [] });
  });

  it("preserves a valid labelSource and drops malformed ones without dropping the operation", () => {
    const base = { sessionId: "s", theaterId: "t", cwd: "/p", cwdLabel: "p", sequence: 1, createdAt: 1 };
    const sanitized = sanitizeDurableConsoleState({
      version: 1,
      theaters: [],
      operations: [
        { ...base, sessionId: "user-op", label: "Bridge Watch", labelSource: "user" },
        { ...base, sessionId: "auto-op", label: "Fix the parser", labelSource: "auto" },
        { ...base, sessionId: "legacy-op", label: "Legacy label" },
        { ...base, sessionId: "bad-op", label: "Bad source", labelSource: "operator" },
      ],
    });

    const bySession = Object.fromEntries(sanitized.operations.map((operation) => [operation.sessionId, operation]));
    expect(bySession["user-op"]?.labelSource).toBe("user");
    expect(bySession["auto-op"]?.labelSource).toBe("auto");
    // 레거시(labelSource 없는) Operation은 그대로 보존되며 labelSource는 undefined로 남는다(read-time에 user로 해석).
    expect(bySession["legacy-op"]).toBeDefined();
    expect(bySession["legacy-op"]?.labelSource).toBeUndefined();
    // 잘못된 labelSource는 필드만 떨궈지고 Operation 자체는 유지된다.
    expect(bySession["bad-op"]?.label).toBe("Bad source");
    expect(bySession["bad-op"]?.labelSource).toBeUndefined();
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

  it("reads provider capture files and merges them into matching dormant operations only", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-captures-"));
    const capturesDir = path.join(dir, "captures");
    tempDirs.push(dir);
    fs.mkdirSync(capturesDir, { recursive: true });
    fs.writeFileSync(path.join(capturesDir, "session-a.json"), JSON.stringify({
      provider: "claude",
      sessionId: "provider-session-secret",
      transcriptPath: "/secret/transcript.jsonl",
      source: "startup",
      capturedAt: "2026-06-16T00:00:00.000Z",
    }));

    const state: DurableConsoleState = {
      version: 1,
      theaters: [],
      operations: [{
        sessionId: "session-a",
        theaterId: "theater-a",
        cwd: "/secret/project",
        cwdLabel: "project",
        sequence: 1,
        createdAt: 1,
      }],
    };
    const capture = readProviderSessionCapture("session-a", { capturesDir });
    const merged = mergeProviderSessionCaptures(state, { capturesDir });

    expect(capture).toMatchObject({ provider: "claude", sessionId: "provider-session-secret" });
    expect(merged.operations[0]?.providerSession).toMatchObject({ provider: "claude", sessionId: "provider-session-secret" });
  });

  it("unlinks provider capture files only through safe capture ids", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-capture-unlink-"));
    const capturesDir = path.join(dir, "captures");
    tempDirs.push(dir);
    fs.mkdirSync(capturesDir, { recursive: true });
    const capturePath = path.join(capturesDir, "session-a.json");
    fs.writeFileSync(capturePath, "{}");

    expect(unlinkProviderSessionCapture("../session-a", { capturesDir })).toBe(false);
    expect(fs.existsSync(capturePath)).toBe(true);
    expect(unlinkProviderSessionCapture("session-a", { capturesDir })).toBe(true);
    expect(fs.existsSync(capturePath)).toBe(false);
  });

  it("cleans up captures that have already been persisted into durable operations", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-capture-cleanup-"));
    const capturesDir = path.join(dir, "captures");
    tempDirs.push(dir);
    fs.mkdirSync(capturesDir, { recursive: true });
    const capturePath = path.join(capturesDir, "session-a.json");
    fs.writeFileSync(capturePath, "{}");

    cleanupProviderSessionCaptures({
      version: 1,
      theaters: [],
      operations: [{
        sessionId: "session-a",
        theaterId: "theater-a",
        cwd: "/secret/project",
        cwdLabel: "project",
        sequence: 1,
        createdAt: 1,
        providerSession: {
          provider: "claude",
          sessionId: "provider-session-secret",
          capturedAt: "2026-06-16T00:00:00.000Z",
        },
      }],
    }, { capturesDir });

    expect(fs.existsSync(capturePath)).toBe(false);
  });
});
