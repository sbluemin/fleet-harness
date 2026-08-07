import { describe, expect, it } from "vitest";

import { canonicalLockFiles, listLocalConsoles } from "../core/host/local-consoles.js";

function scan(locks: Record<string, unknown>, alive: readonly number[] = [1, 2, 3]) {
  return listLocalConsoles({
    lockFiles: Object.keys(locks),
    isAlive: (pid) => alive.includes(pid),
    fileSystem: {
      readFileSync: ((file: string) => {
        const entry = locks[file];
        if (entry === undefined) throw new Error("ENOENT");
        return typeof entry === "string" ? entry : JSON.stringify(entry);
      }) as never,
    },
  });
}

describe("local console discovery", () => {
  it("reports a running console with the address a window can be pointed at", () => {
    const found = scan({ "/a": { pid: 1, endpoint: "http://127.0.0.1:4310/", version: "1.51.0", owner: { kind: "desktop" } } });

    expect(found).toEqual([{ origin: "http://127.0.0.1:4310", version: "1.51.0", owner: "desktop" }]);
  });

  it("scans exactly the two canonical slots and nothing else", () => {
    const files = canonicalLockFiles();

    expect(files.length).toBeLessThanOrEqual(2);
    expect(files.every((file) => file.endsWith("console.lock"))).toBe(true);
  });

  it("drops a lock whose console is gone — a stale file is not a running console", () => {
    const found = scan({ "/a": { pid: 99, endpoint: "http://127.0.0.1:4310/", version: "1.51.0" } }, [1]);

    expect(found).toEqual([]);
  });

  it.each([
    ["an unreadable file", "not json"],
    ["a missing endpoint", { pid: 1, version: "1.0.0" }],
    ["a missing pid", { endpoint: "http://127.0.0.1:4310/", version: "1.0.0" }],
    ["a non-loopback protocol", { pid: 1, endpoint: "https://10.0.0.4:4310/", version: "1.0.0" }],
  ])("ignores %s", (_label, payload) => {
    expect(scan({ "/a": payload })).toEqual([]);
  });

  it("keeps one row per console when both slots point at the same one", () => {
    const lock = { pid: 1, endpoint: "http://127.0.0.1:4310/", version: "1.51.0" };

    expect(scan({ "/a": lock, "/b": lock })).toHaveLength(1);
  });

  it("reads an owner it does not recognise as no owner rather than trusting it", () => {
    const found = scan({ "/a": { pid: 1, endpoint: "http://127.0.0.1:4310/", version: "1.0.0", owner: { kind: "something-else" } } });

    expect(found[0]?.owner).toBeNull();
  });
});
