import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAuthService,
  DEFAULT_AUTH_PATH,
  resolveAuthEnv,
} from "../../../src/infra/auth/index.js";

const tempRoots: string[] = [];

describe("auth providers", () => {
  afterEach(() => {
    createAuthService().setAuthPath(DEFAULT_AUTH_PATH);
    vi.restoreAllMocks();
    for (const tempRoot of tempRoots.splice(0)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns no env for providers without Fleet auth overlay", async () => {
    await expect(resolveAuthEnv("claude")).resolves.toEqual({});
  });

  it("runs validation before returning Claude-family auth env", async () => {
    const auth = createAuthService();
    auth.setAuthPath(createTempAuthPath());
    await auth.setApiKey("Claude Code with Z.AI GLM", "zai-token");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await expect(resolveAuthEnv("claude-zai")).resolves.toEqual({
      ANTHROPIC_AUTH_TOKEN: "zai-token",
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
      API_TIMEOUT_MS: "3000000",
    });
    expect(fetchMock).toHaveBeenCalledWith("https://api.z.ai/api/anthropic/v1/messages", expect.objectContaining({
      headers: expect.objectContaining({
        "x-api-key": "zai-token",
      }),
    }));
  });

  it("fails before returning env when the stored key is missing", async () => {
    const auth = createAuthService();
    auth.setAuthPath(createTempAuthPath());

    await expect(resolveAuthEnv("claude-kimi")).rejects.toThrow("fleet auth login");
  });

  it("fails before returning env when validation rejects the stored key", async () => {
    const auth = createAuthService();
    auth.setAuthPath(createTempAuthPath());
    await auth.setApiKey("Claude Code with Moonshot Kimi", "kimi-token");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("forbidden", { status: 403 }));

    await expect(resolveAuthEnv("claude-kimi")).rejects.toThrow("기함 인증 권한이 부족합니다");
  });
});

function createTempAuthPath(): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-auth-provider-"));
  tempRoots.push(tempRoot);
  return path.join(tempRoot, ".fleet", "auth.json");
}
