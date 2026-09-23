import { expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => vi.fn());
vi.mock("@fleet-console/agent-runtime/claude", () => ({ createClaudeGatewaySdk: sdk }));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn() }));

import { chooseRoutingModel } from "./routing-model.js";

it("requires explicit reselection of a removed Cursor decision model", async () => {
  sdk.mockRejectedValue(new Error("unexpected SDK launch"));
  await expect(chooseRoutingModel({
    baseUrl: "http://127.0.0.1:1",
    directory: "/unused-routing-test",
    settings: { version: 1, delegationRoutingModel: "cursor--retired", models: [] },
    instructions: [], state: {}, criteria: {},
  })).rejects.toThrow("select another model explicitly");
  expect(sdk).not.toHaveBeenCalled();
});

it("does not launch a catalog routing model after it is removed from the roster", async () => {
  sdk.mockRejectedValue(new Error("unexpected SDK launch"));
  await expect(chooseRoutingModel({
    baseUrl: "http://127.0.0.1:1",
    directory: "/unused-routing-test",
    settings: { version: 1, delegationRoutingModel: "claude--fable", models: [] },
    instructions: [], state: {}, criteria: {},
  })).rejects.toThrow("Routing model is not exposed");
  expect(sdk).not.toHaveBeenCalled();
});
