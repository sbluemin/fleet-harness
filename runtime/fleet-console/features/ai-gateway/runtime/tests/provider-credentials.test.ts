import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { codexAuthFilePath, resolveCodexCredentials } from "../src/upstream/codex/credentials.js";
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

describe("codex credential procurement", () => {
  const codexAuth = (tokens: Record<string, unknown>): string => JSON.stringify({ tokens });

  it("reads the default codex home and never shells out on any platform", async () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const execFile = vi.fn(async () => "");
      const readBounded = vi.fn(async () => codexAuth({ access_token: "codex-token", account_id: "acct-1" }));
      const result = await resolveCodexCredentials(deps({ platform, execFile, readBounded }));
      expect(execFile).not.toHaveBeenCalled();
      expect(readBounded).toHaveBeenCalledWith(path.join("/users/operator", ".codex", "auth.json"), 65_536);
      expect(result).toEqual({ accessToken: "codex-token", accountId: "acct-1" });
    }
  });

  // The gateway used to read ~/.codex/auth.json directly, so a relocated Codex
  // home resolved no token there while the quota reader found it.
  it("honors CODEX_HOME when the Codex home is relocated", async () => {
    const readBounded = vi.fn(async () => codexAuth({ access_token: "codex-token", account_id: "acct-1" }));
    await resolveCodexCredentials(deps({ env: { CODEX_HOME: "/custom/codex" }, readBounded }));
    expect(readBounded).toHaveBeenCalledWith(path.join("/custom/codex", "auth.json"), 65_536);
    expect(codexAuthFilePath(deps({ env: { CODEX_HOME: "/custom/codex" } })))
      .toBe(path.join("/custom/codex", "auth.json"));
  });

  it("keeps the account id optional so a quota reader can use a token without one", async () => {
    const result = await resolveCodexCredentials(deps({
      readBounded: async () => codexAuth({ access_token: "codex-token" }),
    }));
    expect(result).toEqual({ accessToken: "codex-token" });
  });

  it("stores the token verbatim rather than trimming it", async () => {
    const result = await resolveCodexCredentials(deps({
      readBounded: async () => codexAuth({ access_token: " codex-token ", account_id: "acct-1" }),
    }));
    expect(result).toEqual({ accessToken: " codex-token ", accountId: "acct-1" });
  });

  it("returns null when the token is absent, empty, or the file is unreadable", async () => {
    await expect(resolveCodexCredentials(deps({ readBounded: async () => codexAuth({ account_id: "acct-1" }) })))
      .resolves.toBeNull();
    await expect(resolveCodexCredentials(deps({ readBounded: async () => codexAuth({ access_token: "" }) })))
      .resolves.toBeNull();
    await expect(resolveCodexCredentials(deps({ readBounded: async () => "{" })))
      .resolves.toBeNull();
    await expect(resolveCodexCredentials(deps({ readBounded: async () => null })))
      .resolves.toBeNull();
    await expect(resolveCodexCredentials(deps({
      readBounded: async () => {
        throw new Error("EACCES");
      },
    }))).resolves.toBeNull();
  });
});
