import { expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => vi.fn());
vi.mock("@fleet-console/agent-runtime/claude", () => ({ createClaudeGatewaySdk: sdk }));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn() }));

import { chooseRoutingModel } from "./routing-model.js";

it("keeps a signed-out routing model stored but runs the roster fallback instead of launching it", async () => {
  const turns: Array<{ model: string; effort?: string }> = [];
  sdk.mockResolvedValue({
    startTurn: async (options: { model: string; effort?: string }) => {
      turns.push({ model: options.model, ...(options.effort ? { effort: options.effort } : {}) });
      return (async function* () { yield { type: "result", subtype: "success", structured_output: {} }; })();
    },
    dispose: async () => undefined,
  });
  const settings = { version: 1 as const, delegationRoutingModel: "codex--gpt-6.1-sol", models: [{ id: "claude--sonnet" }] };
  await chooseRoutingModel({
    baseUrl: "http://127.0.0.1:1",
    directory: "/unused-routing-test",
    settings,
    readProviderStatuses: () => ({ codex: "signed_out" }),
    instructions: [], state: {}, criteria: { seat: "x" }, difficulty: { instructions: [], criteria: {} },
    spawnProcess: () => { throw new Error("unexpected spawn"); },
  }).catch(() => undefined);
  expect(settings.delegationRoutingModel).toBe("codex--gpt-6.1-sol");
  expect(turns).toEqual([{ model: "sonnet[1m]", effort: "low" }]);
});
