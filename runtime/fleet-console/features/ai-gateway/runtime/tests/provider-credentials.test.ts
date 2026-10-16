import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { resolveCursorCredentials } from "../src/upstream/cursor/credentials.js";
import type { CredentialResolverDeps } from "../src/transport/credentials.js";

function deps(overrides: Partial<CredentialResolverDeps> = {}): CredentialResolverDeps {
  return {
    platform: "linux",
    homedir: () => "/users/operator",
    env: {},
    readBounded: vi.fn(async () => null),
    execFile: vi.fn(async () => ""),
    ...overrides,
  };
}

describe("cursor credential procurement", () => {
  it("reads the bare token from the macOS keychain before the auth file", async () => {
    const execFile = vi.fn(async () => "cursor-token\n");
    const readBounded = vi.fn(async () => null);
    const result = await resolveCursorCredentials(deps({ platform: "darwin", execFile, readBounded }));
    expect(execFile).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"],
      { timeout: 5_000 },
    );
    expect(readBounded).not.toHaveBeenCalled();
    expect(result).toEqual({ accessToken: "cursor-token", method: "keychain" });
  });

  // The WSL/Linux regression: `security` does not exist there, so a keychain-only
  // procurement path resolved to no token and the gateway answered 401.
  it("never shells out to the macOS keychain on Linux and reads the XDG auth file", async () => {
    const execFile = vi.fn(async () => "");
    const readBounded = vi.fn(async () => JSON.stringify({ accessToken: "linux-token" }));
    const result = await resolveCursorCredentials(deps({
      platform: "linux",
      env: { XDG_CONFIG_HOME: "/users/operator/.xdg" },
      execFile,
      readBounded,
    }));
    expect(execFile).not.toHaveBeenCalled();
    expect(readBounded).toHaveBeenCalledWith(
      path.join("/users/operator/.xdg", "cursor", "auth.json"),
      65_536,
    );
    expect(result).toEqual({ accessToken: "linux-token", method: "file" });
  });

  it("returns null instead of throwing when the auth file is absent or unreadable", async () => {
    await expect(resolveCursorCredentials(deps({ readBounded: async () => null })))
      .resolves.toBeNull();
    await expect(resolveCursorCredentials(deps({
      readBounded: async () => {
        throw new Error("EACCES");
      },
    }))).resolves.toBeNull();
    await expect(resolveCursorCredentials(deps({ readBounded: async () => "not json" })))
      .resolves.toBeNull();
    await expect(resolveCursorCredentials(deps({ readBounded: async () => JSON.stringify({ accessToken: "   " }) })))
      .resolves.toBeNull();
  });
});
