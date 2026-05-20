import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAuthService, DEFAULT_AUTH_PATH } from "../../../src/infra/auth/index.js";

const tempRoots: string[] = [];

describe("auth storage", () => {
  afterEach(() => {
    createAuthService().setAuthPath(DEFAULT_AUTH_PATH);
    for (const tempRoot of tempRoots.splice(0)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("defaults to ~/.fleet/auth.json", () => {
    expect(DEFAULT_AUTH_PATH).toBe(path.join(os.homedir(), ".fleet", "auth.json"));
  });

  it("stores and reads provider keys from the configured auth path", async () => {
    const authPath = createTempAuthPath();
    const auth = createAuthService();

    auth.setAuthPath(authPath);
    await auth.setApiKey("Claude Code with Z.AI GLM", "zai-token");

    expect(await auth.getApiKey("Claude Code with Z.AI GLM")).toBe("zai-token");
    expect(JSON.parse(fs.readFileSync(authPath, "utf-8"))).toEqual({
      "Claude Code with Z.AI GLM": {
        key: "zai-token",
      },
    });
  });

  it("preserves existing provider metadata when updating a key", async () => {
    const authPath = createTempAuthPath();
    const auth = createAuthService();

    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    fs.writeFileSync(authPath, JSON.stringify({
      "Claude Code with Moonshot Kimi": {
        key: "old-token",
        baseUrl: "https://example.invalid",
      },
    }));

    auth.setAuthPath(authPath);
    await auth.setApiKey("Claude Code with Moonshot Kimi", "new-token");

    expect(JSON.parse(fs.readFileSync(authPath, "utf-8"))).toEqual({
      "Claude Code with Moonshot Kimi": {
        key: "new-token",
        baseUrl: "https://example.invalid",
      },
    });
  });

  it("returns undefined when a provider key is missing", async () => {
    const auth = createAuthService();

    auth.setAuthPath(createTempAuthPath());

    await expect(auth.getApiKey("missing-provider")).resolves.toBeUndefined();
  });

  it("lists configured providers without key material", async () => {
    const auth = createAuthService();

    auth.setAuthPath(createTempAuthPath());
    await auth.setApiKey("Claude Code with Moonshot Kimi", "kimi-token");
    await auth.setApiKey("Claude Code with Z.AI GLM", "zai-token");

    await expect(auth.listProviderIds()).resolves.toEqual([
      "Claude Code with Moonshot Kimi",
      "Claude Code with Z.AI GLM",
    ]);
  });

  it("deletes provider keys and reports whether an entry existed", async () => {
    const auth = createAuthService();

    auth.setAuthPath(createTempAuthPath());
    await auth.setApiKey("Claude Code with Z.AI GLM", "zai-token");

    await expect(auth.deleteApiKey("Claude Code with Z.AI GLM")).resolves.toBe(true);
    await expect(auth.getApiKey("Claude Code with Z.AI GLM")).resolves.toBeUndefined();
    await expect(auth.deleteApiKey("Claude Code with Z.AI GLM")).resolves.toBe(false);
  });
});

function createTempAuthPath(): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-auth-storage-"));
  tempRoots.push(tempRoot);
  return path.join(tempRoot, ".fleet", "auth.json");
}
