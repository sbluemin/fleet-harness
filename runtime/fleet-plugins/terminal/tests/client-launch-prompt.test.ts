import { afterEach, describe, expect, it, vi } from "vitest";

import type { LaunchContext } from "@fleet-console/sdk/plugin";

import { assertSessionInfo, createAgentSession } from "../client/agent/api.js";
import { agentPlugin } from "../client/agent/index.js";
import { getAgentState, removeSession } from "../client/agent/store.js";

afterEach(() => {
  for (const sessionId of Object.keys(getAgentState().sessions)) {
    removeSession(sessionId);
  }
  vi.unstubAllGlobals();
});

describe("agent client launch prompt threading", () => {
  it("sends model, effort, and prompt from variant through createAgentSession", async () => {
    const fetch = stubSessionCreate();
    const launch = agentPlugin.launch;
    if (!launch) throw new Error("Agent plugin launch must exist.");

    await launch(createLaunchContext({
      model: "kimi--k3",
      effort: "max",
      prompt: "ship the prompt",
    }));

    expect(readCreateBody(fetch)).toEqual({
      theaterId: "theater-1",
      cliId: "claude-gateway",
      model: "kimi--k3",
      effort: "max",
      prompt: "ship the prompt",
    });
  });

  it("omits prompt from the request body when variant only has model", async () => {
    const fetch = stubSessionCreate();
    const launch = agentPlugin.launch;
    if (!launch) throw new Error("Agent plugin launch must exist.");

    await launch(createLaunchContext({ model: "fable[1m]" }));

    expect(readCreateBody(fetch)).toEqual({
      theaterId: "theater-1",
      cliId: "claude-gateway",
      model: "fable[1m]",
    });
  });

  it("drops an empty-string prompt from the request body", async () => {
    const fetch = stubSessionCreate();
    const launch = agentPlugin.launch;
    if (!launch) throw new Error("Agent plugin launch must exist.");

    await launch(createLaunchContext({ prompt: "" }, "claude-gateway"));

    expect(readCreateBody(fetch)).toEqual({
      theaterId: "theater-1",
      cliId: "claude-gateway",
    });
  });

  it("rejects a create response body that contains prompt", () => {
    expect(() => assertSessionInfo({
      sessionId: "session-a",
      cwdLabel: "project",
      status: "registered",
      createdAt: 1,
      prompt: "must not round-trip",
    }, 200)).toThrow(/Invalid agent session response/);
  });

  it("createAgentSession itself drops empty prompt while keeping non-empty prompt", async () => {
    const emptyFetch = stubSessionCreate();
    await createAgentSession("theater-1", "claude-gateway", { prompt: "" });
    expect(readCreateBody(emptyFetch)).toEqual({
      theaterId: "theater-1",
      cliId: "claude-gateway",
    });

    const promptFetch = stubSessionCreate();
    await createAgentSession("theater-1", "claude-gateway", { prompt: "keep me" });
    expect(readCreateBody(promptFetch)).toEqual({
      theaterId: "theater-1",
      cliId: "claude-gateway",
      prompt: "keep me",
    });
  });
});

function createLaunchContext(
  variant: Readonly<Record<string, string>>,
  kindId = "claude-gateway",
): LaunchContext {
  return {
    theaterId: "theater-1",
    kind: {
      id: kindId,
      type: "agent",
      title: "Agent",
    },
    geometry: { x: 0, y: 0, width: 1, height: 1, zIndex: 1 },
    operations: {} as LaunchContext["operations"],
    variant,
  };
}

function stubSessionCreate(): { readonly mock: { readonly calls: ReadonlyArray<readonly [unknown, RequestInit?]> } } {
  const fetch = vi.fn(async (_input?: unknown, init?: RequestInit) => new Response(JSON.stringify({
    sessionId: "session-a",
    cwdLabel: "project",
    status: "registered",
    createdAt: 1,
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetch);
  return fetch as unknown as { readonly mock: { readonly calls: ReadonlyArray<readonly [unknown, RequestInit?]> } };
}

function readCreateBody(fetch: { readonly mock: { readonly calls: ReadonlyArray<readonly [unknown, RequestInit?]> } }): unknown {
  const init = fetch.mock.calls[0]?.[1];
  return JSON.parse(String(init?.body));
}
