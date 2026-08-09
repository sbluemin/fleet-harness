import { describe, expect, it } from "vitest";

import { GATEWAY_MODELS, findGatewayModel, toClaudeGatewayModelId } from "@dotobokuri/core-ai-gateway";

import {
  CLAUDE_GATEWAY_MODEL_CACHE_RELPATH,
  claudeGatewayLaunchEnv,
  claudeGatewayModelCache,
} from "../src/claude/launch-env.js";

const BASE_URL = "http://127.0.0.1:43210/plugins/terminal/ai-gateway";
const CONFIG_DIR = "/tmp/core-agent-claude-abc123";

describe("claudeGatewayLaunchEnv", () => {
  it("points the child at the gateway and enables alias discovery", () => {
    const env = claudeGatewayLaunchEnv({}, { baseUrl: BASE_URL, configDir: CONFIG_DIR });
    expect(env.ANTHROPIC_BASE_URL).toBe(BASE_URL);
    expect(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
    expect(env.ENABLE_TOOL_SEARCH).toBe("true");
  });

  it("relocates the config dir and clears the keychain suffix together", () => {
    // 이 둘은 하나의 메커니즘이다. config dir만 옮기면 자식이 없는 keychain 항목을 찾아
    // `Not logged in`으로 죽는다.
    const env = claudeGatewayLaunchEnv({}, { baseUrl: BASE_URL, configDir: CONFIG_DIR });
    expect(env.CLAUDE_CONFIG_DIR).toBe(CONFIG_DIR);
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe("");
  });

  it("strips inherited credentials so the subscription OAuth bearer reaches the gateway", () => {
    const env = claudeGatewayLaunchEnv(
      { ANTHROPIC_API_KEY: "key", ANTHROPIC_AUTH_TOKEN: "token", PATH: "/usr/bin" },
      { baseUrl: BASE_URL, configDir: CONFIG_DIR },
    );
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("strips an inherited ANTHROPIC_MODEL", () => {
    // fleet-admiral의 launch-env가 이 변수를 세우므로 Fleet 터미널에서 기동된 프로세스는
    // 다른 게이트웨이를 가리키는 값을 상속한다.
    const env = claudeGatewayLaunchEnv(
      { ANTHROPIC_MODEL: "claude-gateway--codex--gpt-5.6-sol-fast[1m]" },
      { baseUrl: BASE_URL, configDir: CONFIG_DIR },
    );
    expect(env).not.toHaveProperty("ANTHROPIC_MODEL");
  });

  it("drops undefined inherited entries rather than forwarding them as empty strings", () => {
    const env = claudeGatewayLaunchEnv({ SOMETHING: undefined }, { baseUrl: BASE_URL, configDir: CONFIG_DIR });
    expect(env).not.toHaveProperty("SOMETHING");
  });
});

describe("claudeGatewayModelCache", () => {
  it("names the same baseUrl the child is given", () => {
    const cache = claudeGatewayModelCache({ baseUrl: BASE_URL, models: GATEWAY_MODELS, fetchedAt: 1 });
    expect(cache.baseUrl).toBe(BASE_URL);
  });

  it("advertises exactly the models it was handed, under their Claude-facing ids", () => {
    const model = findGatewayModel("claude-gateway--codex--gpt-5.6-luna-fast[1m]");
    expect(model).toBeDefined();
    const cache = claudeGatewayModelCache({ baseUrl: BASE_URL, models: [model!], fetchedAt: 1 });
    expect(cache.models).toEqual([
      { id: toClaudeGatewayModelId(model!), display_name: expect.any(String) },
    ]);
  });

  it("keeps every catalog entry: Claude Code only accepts claude/anthropic-prefixed ids", () => {
    const cache = claudeGatewayModelCache({ baseUrl: BASE_URL, models: GATEWAY_MODELS, fetchedAt: 1 });
    expect(cache.models).toHaveLength(GATEWAY_MODELS.length);
    for (const model of cache.models) expect(model.id).toMatch(/^claude/i);
  });

  it("pins the path Claude Code reads the cache from", () => {
    expect(CLAUDE_GATEWAY_MODEL_CACHE_RELPATH).toBe("cache/gateway-models.json");
  });
});
