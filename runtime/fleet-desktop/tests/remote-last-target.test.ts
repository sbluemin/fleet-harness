import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createRemoteLastTargetStore } from "../src/runtime/remote/last-target.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("remote last target store", () => {
  it("atomically stores only an SSH target with owner-only permissions", () => {
    const userData = temporaryDirectory();
    const store = createRemoteLastTargetStore(userData);

    store.save("ssh:user@devbox");

    const statePath = path.join(userData, "remote-runtime-last-target.json");
    expect(fs.readFileSync(statePath, "utf8")).toBe('{"sshTarget":"ssh:user@devbox"}\n');
    expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(`${statePath}.tmp`)).toBe(false);
    expect(store.load()).toBe("ssh:user@devbox");
  });

  it("treats missing or corrupt state as empty and refuses non-SSH values", () => {
    const userData = temporaryDirectory();
    const store = createRemoteLastTargetStore(userData);
    const statePath = path.join(userData, "remote-runtime-last-target.json");
    expect(store.load()).toBeNull();
    fs.writeFileSync(statePath, "not-json", "utf8");
    expect(store.load()).toBeNull();
    fs.writeFileSync(statePath, '{"sshTarget":"127.0.0.1:4310"}', "utf8");
    expect(store.load()).toBeNull();
    store.save("127.0.0.1:4310");
    expect(fs.readFileSync(statePath, "utf8")).toBe('{"sshTarget":"127.0.0.1:4310"}');
  });

  it("keeps persistence failures best-effort", () => {
    const fileSystem = {
      readFileSync: vi.fn(() => { throw new Error("missing"); }),
      mkdirSync: vi.fn(() => undefined),
      writeFileSync: vi.fn(() => { throw new Error("read-only"); }),
      renameSync: vi.fn(),
    };
    const store = createRemoteLastTargetStore("/user-data", fileSystem);
    expect(() => store.save("ssh:devbox")).not.toThrow();
    expect(fileSystem.renameSync).not.toHaveBeenCalled();
  });
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desktop-remote-target-"));
  temporaryDirectories.push(directory);
  return directory;
}
