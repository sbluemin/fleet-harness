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

it("uses a stored routing effort on the model that actually launches, clamped to that ladder", async () => {
  const turns: Array<{ model: string; effort?: string }> = [];
  sdk.mockResolvedValue({
    startTurn: async (options: { model: string; effort?: string }) => {
      turns.push({ model: options.model, ...(options.effort ? { effort: options.effort } : {}) });
      return (async function* () { yield { type: "result", subtype: "success", structured_output: {} }; })();
    },
    dispose: async () => undefined,
  });
  const launch = (settings: { readonly delegationRoutingModel: string; readonly delegationRoutingEffort: "max" | "high" }, statuses?: () => { xai: "signed_out" }) => chooseRoutingModel({
    baseUrl: "http://127.0.0.1:1",
    directory: "/unused-routing-test",
    settings: { version: 1, ...settings },
    ...(statuses ? { readProviderStatuses: statuses } : {}),
    instructions: [], state: {}, criteria: { seat: "x" }, difficulty: { instructions: [], criteria: {} },
    spawnProcess: () => { throw new Error("unexpected spawn"); },
  }).catch(() => undefined);

  const clamped = { delegationRoutingModel: "xai--grok-4.7", delegationRoutingEffort: "max" as const };
  await launch(clamped);
  expect(clamped.delegationRoutingEffort).toBe("max");
  expect(turns).toEqual([{ model: "claude-gateway--xai--grok-4.7", effort: "xhigh" }]);

  turns.length = 0;
  const omitted = { delegationRoutingModel: "xai--grok-composer-2.5-fast", delegationRoutingEffort: "high" as const };
  await launch(omitted);
  expect(turns).toEqual([{ model: "claude-gateway--xai--grok-composer-2.5-fast" }]);

  turns.length = 0;
  const fallen = { delegationRoutingModel: "xai--grok-4.7", delegationRoutingEffort: "max" as const };
  await launch(fallen, () => ({ xai: "signed_out" }));
  expect(fallen.delegationRoutingModel).toBe("xai--grok-4.7");
  expect(turns).toEqual([{ model: "sonnet[1m]", effort: "max" }]);
});
