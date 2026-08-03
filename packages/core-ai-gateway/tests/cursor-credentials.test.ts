import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  cursorAuthFilePath,
  resolveCursorCredentials,
  type CredentialResolverDeps,
} from "../src/cursor-credentials.js";

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

  it("falls back to the macOS auth file when the keychain lookup fails", async () => {
    const execFile = vi.fn(async () => {
      throw new Error("no keychain entry");
    });
    const readBounded = vi.fn(async () => JSON.stringify({ accessToken: "file-token" }));
    const result = await resolveCursorCredentials(deps({ platform: "darwin", execFile, readBounded }));
    expect(readBounded).toHaveBeenCalledWith(
      path.join("/users/operator", ".cursor", "auth.json"),
      65_536,
    );
    expect(result).toEqual({ accessToken: "file-token", method: "file" });
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

  it("defaults to ~/.config on Linux when XDG_CONFIG_HOME is unset", async () => {
    const readBounded = vi.fn(async () => JSON.stringify({ accessToken: "linux-token" }));
    await resolveCursorCredentials(deps({ platform: "linux", readBounded }));
    expect(readBounded).toHaveBeenCalledWith(
      path.join("/users/operator", ".config", "cursor", "auth.json"),
      65_536,
    );
  });

  it("reads the roaming auth file on Windows without touching the keychain", async () => {
    const execFile = vi.fn(async () => "");
    const readBounded = vi.fn(async () => JSON.stringify({ accessToken: "win-token" }));
    const result = await resolveCursorCredentials(deps({
      platform: "win32",
      homedir: () => "C:\\Users\\operator",
      env: { APPDATA: "C:\\Users\\operator\\AppData\\Roaming" },
      execFile,
      readBounded,
    }));
    expect(execFile).not.toHaveBeenCalled();
    expect(readBounded).toHaveBeenCalledWith(
      path.join("C:\\Users\\operator\\AppData\\Roaming", "Cursor", "auth.json"),
      65_536,
    );
    expect(result).toEqual({ accessToken: "win-token", method: "file" });
  });

  it("accepts every auth-file token shape Cursor has written", async () => {
    const shapes = [
      { accessToken: "a" },
      { access_token: "a" },
      { tokens: { accessToken: "a" } },
      { tokens: { access_token: "a" } },
      { cursorAuth: { accessToken: "a" } },
      { cursorAuth: { access_token: "a" } },
    ];
    for (const shape of shapes) {
      const result = await resolveCursorCredentials(deps({
        readBounded: async () => JSON.stringify(shape),
      }));
      expect(result).toEqual({ accessToken: "a", method: "file" });
    }
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

  it("resolves the same auth-file path the resolver reads", () => {
    expect(cursorAuthFilePath(deps({ platform: "darwin" })))
      .toBe(path.join("/users/operator", ".cursor", "auth.json"));
    expect(cursorAuthFilePath(deps({ platform: "linux" })))
      .toBe(path.join("/users/operator", ".config", "cursor", "auth.json"));
  });
});
