import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findGatewayModel } from "@dotobokuri/core-ai-gateway";
import { afterEach, describe, expect, it } from "vitest";

import { buildGatewayModelsToolSpec } from "../src/ai-gateway/gateway-models-tool.js";

const GUARD_SCRIPT = fileURLToPath(new URL("../assets/hooks/fleet-gateway-model-guard.mjs", import.meta.url));
const TEST_TEMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fleet-routing-refresh-test-"));
const RECEIPT_ROOT = path.join(TEST_TEMP_ROOT, "fleet-routing-receipts");
const SESSION_ID = "session-refresh-receipt";
const PROMPT_ID = "prompt-refresh-receipt";
const ROUTING_NONCE = "nonce-refresh-receipt";
const MODEL_ID = "cursor--grok-4.5-fast";

function model() {
  const found = findGatewayModel(MODEL_ID);
  if (!found) throw new Error(`missing catalog model: ${MODEL_ID}`);
  return found;
}

function runHook(
  subcommand: string,
  payload: unknown,
  routingNonce = ROUTING_NONCE,
) {
  const result = spawnSync(process.execPath, [GUARD_SCRIPT, subcommand, routingNonce], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, FLEET_ROUTING_RECEIPT_ROOT: RECEIPT_ROOT },
  });
  return { status: result.status ?? -1, stderr: result.stderr };
}

function runGuard(toolName: "Agent" | "Workflow", toolInput: unknown, coordinates = {
  sessionId: SESSION_ID,
  promptId: PROMPT_ID,
  routingNonce: ROUTING_NONCE,
}) {
  return runHook("gate-delegation", {
    session_id: coordinates.sessionId,
    prompt_id: coordinates.promptId,
    tool_name: toolName,
    tool_input: toolInput,
  }, coordinates.routingNonce);
}

function beginOrchestration() {
  return runHook("begin-orchestration", {
    session_id: SESSION_ID,
    prompt_id: PROMPT_ID,
    tool_name: "Skill",
    tool_input: { skill: "fleet:orchestration" },
  });
}

afterEach(() => {
  rmSync(RECEIPT_ROOT, { recursive: true, force: true });
  rmSync(`${RECEIPT_ROOT}-target`, { recursive: true, force: true });
});

describe("gateway routing refresh receipt", () => {
  it("allows only identities and model ids from the successful prompt-scoped refresh", async () => {
    const spec = buildGatewayModelsToolSpec({
      routingReceiptRoot: RECEIPT_ROOT,
      readSelection: () => ({ models: [model()] }),
    });
    await spec.execute({
      hookEventName: "PostToolUse",
      sessionId: SESSION_ID,
      promptId: PROMPT_ID,
      routingNonce: ROUTING_NONCE,
    }, {} as never);

    expect(existsSync(RECEIPT_ROOT)).toBe(true);
    expect(runGuard("Agent", { subagent_type: "fleet:cursor-grok-4-5-fast-high" }).status).toBe(0);
    expect(runGuard("Workflow", {
      script: `agent("x", { model: "claude-gateway--cursor--grok-4.5-fast" })`,
    }).status).toBe(0);

    const staleAgent = runGuard("Agent", { subagent_type: "fleet:removed-identity" });
    expect(staleAgent.status).toBe(2);
    expect(staleAgent.stderr).toContain("not in the fresh gateway roster");

    const staleModel = runGuard("Workflow", {
      script: `agent("x", { model: "claude-gateway--xai--grok-4.6" })`,
    });
    expect(staleModel.status).toBe(2);
    expect(staleModel.stderr).toContain("not in the fresh gateway roster");
  });

  it("rejects a receipt from another prompt or launched session", async () => {
    const spec = buildGatewayModelsToolSpec({
      routingReceiptRoot: RECEIPT_ROOT,
      readSelection: () => ({ models: [model()] }),
    });
    await spec.execute({
      hookEventName: "PostToolUse",
      sessionId: SESSION_ID,
      promptId: PROMPT_ID,
      routingNonce: ROUTING_NONCE,
    }, {} as never);

    for (const coordinates of [
      { sessionId: SESSION_ID, promptId: "another-prompt", routingNonce: ROUTING_NONCE },
      { sessionId: SESSION_ID, promptId: PROMPT_ID, routingNonce: "another-launch" },
    ]) {
      const result = runGuard("Agent", { subagent_type: "fleet:cursor-grok-4-5-fast-high" }, coordinates);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("refresh did not complete");
    }
  });

  it("writes no receipt when the live selection read fails", async () => {
    const spec = buildGatewayModelsToolSpec({
      routingReceiptRoot: RECEIPT_ROOT,
      readSelection: () => { throw new Error("settings unavailable"); },
    });
    await expect(spec.execute({
      hookEventName: "PostToolUse",
      sessionId: SESSION_ID,
      promptId: PROMPT_ID,
      routingNonce: ROUTING_NONCE,
    }, {} as never)).rejects.toThrow("settings unavailable");

    const result = runGuard("Agent", { subagent_type: "fleet:cursor-grok-4-5-fast-high" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("refresh did not complete");
  });

  it("invalidates an earlier success before a repeated orchestration refresh", async () => {
    const success = buildGatewayModelsToolSpec({
      routingReceiptRoot: RECEIPT_ROOT,
      readSelection: () => ({ models: [model()] }),
    });
    await success.execute({
      hookEventName: "PostToolUse",
      sessionId: SESSION_ID,
      promptId: PROMPT_ID,
      routingNonce: ROUTING_NONCE,
    }, {} as never);
    expect(runGuard("Agent", { subagent_type: "fleet:cursor-grok-4-5-fast-high" }).status).toBe(0);

    expect(beginOrchestration().status).toBe(0);
    const failedRefresh = buildGatewayModelsToolSpec({
      routingReceiptRoot: RECEIPT_ROOT,
      readSelection: () => { throw new Error("settings unavailable"); },
    });
    await expect(failedRefresh.execute({
      hookEventName: "PostToolUse",
      sessionId: SESSION_ID,
      promptId: PROMPT_ID,
      routingNonce: ROUTING_NONCE,
    }, {} as never)).rejects.toThrow("settings unavailable");

    const result = runGuard("Agent", { subagent_type: "fleet:cursor-grok-4-5-fast-high" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("refresh did not complete");
  });

  it("removes the launch receipt on SessionEnd", async () => {
    const spec = buildGatewayModelsToolSpec({
      routingReceiptRoot: RECEIPT_ROOT,
      readSelection: () => ({ models: [model()] }),
    });
    await spec.execute({
      hookEventName: "PostToolUse",
      sessionId: SESSION_ID,
      promptId: PROMPT_ID,
      routingNonce: ROUTING_NONCE,
    }, {} as never);

    expect(runHook("cleanup-routing", {
      session_id: SESSION_ID,
      prompt_id: PROMPT_ID,
      hook_event_name: "SessionEnd",
      reason: "other",
    }).status).toBe(0);
    expect(runGuard("Agent", { subagent_type: "fleet:cursor-grok-4-5-fast-high" }).status).toBe(2);
  });

  it("refuses a symlinked receipt root", async () => {
    rmSync(RECEIPT_ROOT, { recursive: true, force: true });
    const target = `${RECEIPT_ROOT}-target`;
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    symlinkSync(target, RECEIPT_ROOT, "dir");
    const spec = buildGatewayModelsToolSpec({
      routingReceiptRoot: RECEIPT_ROOT,
      readSelection: () => ({ models: [model()] }),
    });

    await expect(spec.execute({
      hookEventName: "PostToolUse",
      sessionId: SESSION_ID,
      promptId: PROMPT_ID,
      routingNonce: ROUTING_NONCE,
    }, {} as never)).rejects.toThrow("Routing receipt root is unsafe");
    rmSync(RECEIPT_ROOT, { force: true });
    rmSync(target, { recursive: true, force: true });
  });
});
