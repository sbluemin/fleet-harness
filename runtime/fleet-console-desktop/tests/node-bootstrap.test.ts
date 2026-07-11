import { describe, expect, it, vi } from "vitest";

import { bootstrapNodeRuntime } from "../src/runtime/node-bootstrap.js";

const manifest = { version: "22.23.1", source: "https://node.invalid", targets: { "darwin-arm64": { archive: "node.tar.gz", sha256: "good" }, "win32-x64": { archive: "node.zip", sha256: "good" } } };

function dependencies() {
  return {
    download: vi.fn(async () => undefined),
    extract: vi.fn(async () => undefined),
    fileSystem: { mkdir: vi.fn(async () => undefined), readFile: vi.fn(async () => new Uint8Array([1])), rename: vi.fn(async () => undefined), rm: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined) },
    hash: () => "good",
  };
}

describe("Node runtime bootstrap", () => {
  it("downloads, verifies, extracts, and promotes the pinned runtime", async () => {
    const injected = dependencies();
    await expect(bootstrapNodeRuntime({ destination: "/runtime/node", manifest, platform: "darwin", architecture: "arm64", dependencies: injected })).resolves.toEqual({ nodePath: "/runtime/node/bin/node", version: "22.23.1" });
    expect(injected.download).toHaveBeenCalledWith("https://node.invalid/node.tar.gz", "/runtime/node.staging/node.tar.gz");
    expect(injected.extract).toHaveBeenCalledWith("/runtime/node.staging/node.tar.gz", "/runtime/node.staging", "darwin");
    expect(injected.fileSystem.rename).toHaveBeenCalledWith("/runtime/node.staging", "/runtime/node");
  });

  it("cleans partial output when checksum verification fails", async () => {
    const injected = dependencies();
    injected.hash = () => "bad";
    await expect(bootstrapNodeRuntime({ destination: "/runtime/node", manifest, platform: "darwin", architecture: "arm64", dependencies: injected })).rejects.toThrow("node_runtime_checksum_mismatch");
    expect(injected.fileSystem.rm).toHaveBeenLastCalledWith("/runtime/node.staging");
  });

  it("uses the Windows node executable without executing it", async () => {
    const injected = dependencies();
    await expect(bootstrapNodeRuntime({ destination: "C:/runtime/node", manifest, platform: "win32", architecture: "x64", dependencies: injected })).resolves.toMatchObject({ nodePath: "C:/runtime/node/node.exe" });
  });
});
