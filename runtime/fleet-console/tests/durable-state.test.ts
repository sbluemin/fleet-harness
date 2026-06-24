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
