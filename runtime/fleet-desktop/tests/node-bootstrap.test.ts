import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { bootstrapNodeRuntime, createNodeBootstrapDependencies, createPowerShellExtractionCommand, downloadVerifiedNodeArchive, isManagedNodeRuntimeValid, reconcileNodeRuntime, satisfiesNodeEngine } from "../src/runtime/node-bootstrap.js";

const manifest = { version: "22.23.1", source: "https://node.invalid", targets: { "darwin-arm64": { archive: "node.tar.gz", sha256: "good" }, "win32-x64": { archive: "node.zip", sha256: "good" } } };

function dependencies() {
  return {
    download: vi.fn(async () => undefined),
    extract: vi.fn(async () => undefined),
    fileSystem: { mkdir: vi.fn(async () => undefined), readFile: vi.fn(async () => new Uint8Array([1])), rename: vi.fn(async () => undefined), rm: vi.fn(async () => undefined), stat: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined) },
    hash: () => "good",
  };
}

describe("Node runtime bootstrap", () => {
  it("downloads, verifies, extracts, and promotes the pinned runtime", async () => {
    const injected = dependencies();
    const destination = path.resolve("/runtime/node");
    const staging = `${destination}.staging`;
    const archive = path.join(staging, "node.tar.gz");
    await expect(bootstrapNodeRuntime({ destination, manifest, platform: "darwin", architecture: "arm64", dependencies: injected })).resolves.toEqual({ nodePath: path.join(destination, "bin", "node"), version: "22.23.1" });
    expect(injected.download).toHaveBeenCalledWith("https://node.invalid/node.tar.gz", archive);
    expect(injected.extract).toHaveBeenCalledWith(archive, staging, "darwin");
    expect(injected.fileSystem.rename).toHaveBeenCalledWith(staging, destination);
  });

  it("cleans partial output when checksum verification fails", async () => {
    const injected = dependencies();
    injected.hash = () => "bad";
    await expect(bootstrapNodeRuntime({ destination: "/runtime/node", manifest, platform: "darwin", architecture: "arm64", dependencies: injected })).rejects.toThrow("node_runtime_checksum_mismatch");
    expect(injected.fileSystem.rm).toHaveBeenLastCalledWith("/runtime/node.staging");
  });

  it("accepts the trusted manifest only when it satisfies the installed Console engine", () => {
    expect(satisfiesNodeEngine("22.23.1", ">=22.12.0")).toBe(true);
    expect(satisfiesNodeEngine("22.11.0", ">=22.12.0")).toBe(false);
    expect(satisfiesNodeEngine("22.23.1", "^22.12.0")).toBe(false);
  });

  it("restores an interrupted Node rollback before any download when node is missing", async () => {
    // 교체 중 종료: node 부재(stat 실패)+rollback 존재(stat 성공) → 다운로드 전에 rollback을 복원한다.
    const stat = vi.fn(async (target: string) => { if (target === "/runtime/node") throw new Error("missing"); });
    const fileSystem = { stat, rename: vi.fn(async () => undefined), rm: vi.fn(async () => undefined) };
    await expect(reconcileNodeRuntime("/runtime/node", fileSystem)).resolves.toBeUndefined();
    expect(fileSystem.rename).toHaveBeenCalledWith("/runtime/node.rollback", "/runtime/node");
    expect(fileSystem.rm).not.toHaveBeenCalled();
  });

  it("escapes apostrophes in every PowerShell literal path", () => {
    const command = createPowerShellExtractionCommand("C:\\Users\\O'Brien\\node.zip", "C:\\Users\\O'Brien\\runtime");
    expect(command).toContain("-LiteralPath 'C:\\Users\\O''Brien\\node.zip'");
    expect(command).toContain("Join-Path 'C:\\Users\\O''Brien\\runtime' 'extract'");
    expect(command).toContain("-Destination 'C:\\Users\\O''Brien\\runtime'");
  });
});
