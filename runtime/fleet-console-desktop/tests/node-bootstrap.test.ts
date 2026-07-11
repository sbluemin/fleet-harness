import { describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { bootstrapNodeRuntime, createNodeBootstrapDependencies, createPowerShellExtractionCommand, isManagedNodeRuntimeValid, reconcileNodeRuntime, satisfiesNodeEngine } from "../src/runtime/node-bootstrap.js";

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

  it("accepts the trusted manifest only when it satisfies the installed Console engine", () => {
    expect(satisfiesNodeEngine("22.23.1", ">=22.12.0")).toBe(true);
    expect(satisfiesNodeEngine("22.11.0", ">=22.12.0")).toBe(false);
    expect(satisfiesNodeEngine("22.23.1", "^22.12.0")).toBe(false);
  });

  it("requires both the trusted marker and managed executable before reusing Node", async () => {
    const fileSystem = { readFile: vi.fn(async () => new TextEncoder().encode("22.23.1\n")), stat: vi.fn(async () => undefined) };
    await expect(isManagedNodeRuntimeValid("/runtime/node", manifest, "darwin", fileSystem)).resolves.toBe(true);
    fileSystem.readFile.mockResolvedValueOnce(new TextEncoder().encode("22.22.0\n"));
    await expect(isManagedNodeRuntimeValid("/runtime/node", manifest, "darwin", fileSystem)).resolves.toBe(false);
    fileSystem.stat.mockRejectedValueOnce(new Error("missing executable"));
    await expect(isManagedNodeRuntimeValid("/runtime/node", manifest, "darwin", fileSystem)).resolves.toBe(false);
  });

  it("best-effort cleans a stale Node rollback once the managed runtime is valid", async () => {
    const fileSystem = { rm: vi.fn(async () => { throw new Error("locked"); }) };
    await expect(reconcileNodeRuntime("/runtime/node", fileSystem)).resolves.toBeUndefined();
    expect(fileSystem.rm).toHaveBeenCalledWith("/runtime/node.rollback");
  });

  it("escapes apostrophes in every PowerShell literal path", () => {
    const command = createPowerShellExtractionCommand("C:\\Users\\O'Brien\\node.zip", "C:\\Users\\O'Brien\\runtime");
    expect(command).toContain("-LiteralPath 'C:\\Users\\O''Brien\\node.zip'");
    expect(command).toContain("Join-Path 'C:\\Users\\O''Brien\\runtime' 'extract'");
    expect(command).toContain("-Destination 'C:\\Users\\O''Brien\\runtime'");
  });

  it("passes the escaped PowerShell command to execFile for Windows ZIP extraction", async () => {
    execFileMock.mockImplementationOnce((_command: string, _arguments: readonly string[], callback: (error: Error | null, stdout: string, stderr: string) => void) => callback(null, "", ""));
    const dependencies = createNodeBootstrapDependencies();
    await dependencies.extract("C:\\Users\\O'Brien\\node.zip", "C:\\Users\\O'Brien\\runtime", "win32");
    expect(execFileMock).toHaveBeenCalledWith("powershell", ["-NoProfile", "-NonInteractive", "-Command", expect.stringContaining("O''Brien")], expect.any(Function));
  });
});
