import { describe, expect, it, vi } from "vitest";

import { canonicalLockFiles, listLocalConsoles, type LocalConsoleScanDeps } from "../core/host/local-consoles.js";

interface Harness {
  readonly locks?: Record<string, unknown>;
  readonly dirs?: Record<string, readonly string[]>;
  readonly alive?: readonly number[];
  readonly platform?: NodeJS.Platform;
  readonly distros?: readonly string[];
  readonly unreachable?: readonly string[];
}

function scan(harness: Harness) {
  const locks = harness.locks ?? {};
  const deps: LocalConsoleScanDeps = {
    lockFiles: Object.keys(locks).filter((file) => !file.startsWith("\\\\")),
    isAlive: (pid) => (harness.alive ?? [1, 2, 3]).includes(pid),
    platform: harness.platform ?? "darwin",
    listWslDistros: () => harness.distros ?? [],
    reachable: async (origin) => !(harness.unreachable ?? []).includes(origin),
    fileSystem: {
      readFileSync: ((file: string) => {
        const entry = locks[file];
        if (entry === undefined) throw new Error("ENOENT");
        return typeof entry === "string" ? entry : JSON.stringify(entry);
      }) as never,
      readdirSync: ((dir: string) => {
        const entry = (harness.dirs ?? {})[dir];
        if (entry === undefined) throw new Error("ENOENT");
        return entry;
      }) as never,
    },
  };
  return listLocalConsoles(deps);
}

const RUNNING = { pid: 1, endpoint: "http://127.0.0.1:4310/", version: "1.51.0", owner: { kind: "desktop" } };

describe("local console discovery", () => {
  it("reports a running console with the address a window can be pointed at", async () => {
    await expect(scan({ locks: { "/a": RUNNING } })).resolves.toEqual([
      { origin: "http://127.0.0.1:4310", version: "1.51.0", owner: "desktop", distro: null },
    ]);
  });

  it("scans exactly the two canonical slots and nothing else", () => {
    const files = canonicalLockFiles();

    expect(files.length).toBeLessThanOrEqual(2);
    expect(files.every((file) => file.endsWith("console.lock"))).toBe(true);
  });

  it("drops a lock whose console is gone — a stale file is not a running console", async () => {
    await expect(scan({ locks: { "/a": { ...RUNNING, pid: 99 } }, alive: [1] })).resolves.toEqual([]);
  });

  it.each([
    ["an unreadable file", "not json"],
    ["a missing endpoint", { pid: 1, version: "1.0.0" }],
    ["a missing pid", { endpoint: "http://127.0.0.1:4310/", version: "1.0.0" }],
    ["a non-loopback protocol", { pid: 1, endpoint: "https://10.0.0.4:4310/", version: "1.0.0" }],
  ])("ignores %s", async (_label, payload) => {
    await expect(scan({ locks: { "/a": payload } })).resolves.toEqual([]);
  });

  it("keeps one row per console when both slots point at the same one", async () => {
    await expect(scan({ locks: { "/a": RUNNING, "/b": RUNNING } })).resolves.toHaveLength(1);
  });

  it("reads an owner it does not recognise as no owner rather than trusting it", async () => {
    const found = await scan({ locks: { "/a": { ...RUNNING, owner: { kind: "something-else" } } } });

    expect(found[0]?.owner).toBeNull();
  });
});

describe("WSL console discovery", () => {
  const WSL_LOCK = "\\\\wsl.localhost\\Ubuntu\\tmp\\fleet-console-1000-stable\\console.lock";
  const wsl: Harness = {
    platform: "win32",
    distros: ["Ubuntu"],
    dirs: { "\\\\wsl.localhost\\Ubuntu\\tmp": ["fleet-console-1000-stable", "systemd-private-abc", "snap.x"] },
    locks: { [WSL_LOCK]: { pid: 7, endpoint: "http://127.0.0.1:52000/", version: "1.51.0", owner: { kind: "cli" } } },
  };

  it("finds a console inside a running distro and names where it lives", async () => {
    await expect(scan(wsl)).resolves.toEqual([
      { origin: "http://127.0.0.1:52000", version: "1.51.0", owner: "cli", distro: "Ubuntu" },
    ]);
  });

  /**
   * 배포판 안의 pid는 그쪽 네임스페이스의 것이다. 여기서 물으면 같은 숫자를 가진 Windows
   * 프로세스를 가리켜, 죽은 콘솔이 살아 있는 것으로 읽힌다.
   */
  it("judges a WSL console by its port, never by the pid the lock carries", async () => {
    // pid 7은 살아 있다고 답하도록 두었는데도, 포트가 침묵하면 목록에 오르지 않는다.
    await expect(scan({ ...wsl, alive: [7], unreachable: ["http://127.0.0.1:52000"] })).resolves.toEqual([]);
  });

  it("looks inside no distro on a platform that has none", async () => {
    const readdirSync = vi.fn();
    await listLocalConsoles({
      lockFiles: [],
      platform: "darwin",
      listWslDistros: () => ["Ubuntu"],
      fileSystem: { readFileSync: (() => { throw new Error("ENOENT"); }) as never, readdirSync: readdirSync as never },
    });

    expect(readdirSync).not.toHaveBeenCalled();
  });

  it.each([
    ["a path traversal", ".."],
    ["a separator", "Ubuntu\\..\\..\\Windows"],
    ["a share hop", "server\\share"],
    ["an empty name", ""],
  ])("refuses %s as a distro name instead of building that path", async (_label, distro) => {
    const readdirSync = vi.fn();
    await listLocalConsoles({
      lockFiles: [],
      platform: "win32",
      listWslDistros: () => [distro],
      fileSystem: { readFileSync: (() => { throw new Error("ENOENT"); }) as never, readdirSync: readdirSync as never },
    });

    expect(readdirSync).not.toHaveBeenCalled();
  });

  it("keeps going when one distro's share cannot be read", async () => {
    const found = await scan({
      ...wsl,
      distros: ["Stopped", "Ubuntu"],
      dirs: { "\\\\wsl.localhost\\Ubuntu\\tmp": ["fleet-console-1000-stable"] },
    });

    expect(found.map((entry) => entry.distro)).toEqual(["Ubuntu"]);
  });

  it("prefers the console on this side when both report the same address", async () => {
    const found = await scan({
      ...wsl,
      locks: { "/native": { ...RUNNING, endpoint: "http://127.0.0.1:52000/" }, [WSL_LOCK]: { pid: 7, endpoint: "http://127.0.0.1:52000/", version: "1.51.0" } },
    });

    expect(found).toHaveLength(1);
    expect(found[0]?.distro).toBeNull();
  });
});
