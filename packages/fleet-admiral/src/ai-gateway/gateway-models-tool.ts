/**
 * ai-gateway/gateway-models-tool — live roster of the gateway models a host may
 * assign to workflow stages.
 *
 * Ordinary calls report facts and stop there. Hook-mode calls wrap the same fresh
 * reading in Claude Code's PostToolUse context envelope; dispatch enforcement remains
 * in the gateway model guard hook.
 */

import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentToolSpec } from "@dotobokuri/core-agent";
import type { GatewayModel, GatewayProvider } from "@dotobokuri/core-ai-gateway";

import type { GatewayEffortExposure } from "../agent-cli/gateway-agents.js";
import {
  buildGatewayLoadout,
  type GatewayLoadout,
  type GatewayQuotaSnapshot,
} from "./model-loadout.js";

export const GATEWAY_MODELS_TOOL_ID = "gateway_models";

export interface GatewayModelsSelection {
  /** Exactly the delegable models the user exposed — the exposed set minus the ones reserved for the host session. Never the whole catalog. */
  readonly models: readonly GatewayModel[];
  /** Per-model reasoning rungs the user exposed. Absent entry = that model's whole ladder. */
  readonly effortExposure?: GatewayEffortExposure;
  /** The user's opt-in ordered spend preference across providers; weights the allowance axis only. */
  readonly providerPriority?: readonly GatewayProvider[];
}

export interface GatewayModelsToolDeps {
  /** Read at call time; the exposed set is user-editable while a session runs. */
  readonly readSelection: () => Promise<GatewayModelsSelection> | GatewayModelsSelection;
  /** Omitted when the host cannot read allowances; every provider then reports `unsupported`. */
  readonly readQuota?: () => Promise<GatewayQuotaSnapshot | undefined> | GatewayQuotaSnapshot | undefined;
  /** Test-only isolation for private hook receipts. Runtime calls use the OS temporary root. */
  readonly routingReceiptRoot?: string;
}

interface GatewayModelsToolInput {
  /** Hook event whose additional context should receive this reading. Omit for an ordinary tool result. */
  readonly hookEventName?: "PostToolUse";
  /** Claude hook coordinates. Required together in hook mode so a later dispatch can consume this exact receipt. */
  readonly sessionId?: string;
  readonly promptId?: string;
  /** Opaque per-session launch identity; never included in model-visible context. */
  readonly routingNonce?: string;
}

interface RoutingReceiptStore {
  readonly root: string;
}

const DEFAULT_ROUTING_RECEIPT_ROOT = path.join(os.tmpdir(), "fleet-routing-receipts");
const ROUTING_RECEIPT_MODE = 0o600;
const ROUTING_RECEIPT_DIR_MODE = 0o700;

const GATEWAY_MODELS_DOCTRINE = {
  id: GATEWAY_MODELS_TOOL_ID,
  tag: GATEWAY_MODELS_TOOL_ID,
  title: "gateway_models Tool Guidelines",
  // MCP로 실제 전달되는 필드는 description 하나다(core-agent specToMcpTool). whenToUse·
  // usageGuidelines에 적은 문장은 모델에 도달하지 않으므로, 틀리면 조용히 실패하는 두 규칙은
  // 여기에 둔다. 나머지 판정 규칙은 응답 본문을 보면 알 수 있어 싣지 않는다 — 길어질수록
  // 읽히지 않고, 읽히지 않으면 없는 것과 같다.
  description:
    `Report the gateway models currently available to this session, each model's routing constraints, capability class, and benchmark evidence, and the current provider allowances and the user's provider spend priority.`
    + ` The roster is the models the user exposed in the Console minus the ones reserved for the host session, and it is editable while this session runs, so it is resolved at call time rather than remembered.`
    + ` Two spellings, never interchangeable: agentTypes names an identity for the Agent tool's subagent_type, while modelId is the model as a value for a workflow stage's opts.model — each is refused where the other belongs.`
    + ` Names are registered once at session start while this roster is re-read live, so a model or reasoning rung exposed mid-session appears here under a name that will not resolve until a new session.`,
  promptSnippet:
    `gateway_models — Live roster of assignable gateway models: constraints, capability class, benchmark evidence, provider allowances, and the user's provider priority.`,
  whenToUse: [],
  whenNotToUse: [],
  usageGuidelines: [],
};

export function buildGatewayModelsToolSpec(deps: GatewayModelsToolDeps): AgentToolSpec {
  return {
    ...GATEWAY_MODELS_DOCTRINE,
    parameters: {
      type: "object",
      properties: {
        hookEventName: { type: "string", enum: ["PostToolUse"] },
        sessionId: { type: "string" },
        promptId: { type: "string" },
        routingNonce: { type: "string" },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const loadout = await resolveLoadout(deps);
      const input = isGatewayModelsToolInput(args) ? args : {};
      if (input.hookEventName === "PostToolUse") {
        writeRoutingReceipt(input, loadout, {
          root: deps.routingReceiptRoot ?? DEFAULT_ROUTING_RECEIPT_ROOT,
        });
      }
      return {
        content: [{
          type: "text" as const,
          text: input.hookEventName === "PostToolUse"
            ? JSON.stringify({
                hookSpecificOutput: {
                  hookEventName: "PostToolUse",
                  additionalContext: routingContext(loadout),
                },
              })
            : JSON.stringify(loadout),
        }],
        isError: false,
        details: loadout,
      };
    },
  };
}

function isGatewayModelsToolInput(value: unknown): value is GatewayModelsToolInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  if (input.hookEventName !== undefined && input.hookEventName !== "PostToolUse") return false;
  return [input.sessionId, input.promptId, input.routingNonce]
    .every((field) => field === undefined || typeof field === "string");
}

function writeRoutingReceipt(
  input: GatewayModelsToolInput,
  loadout: GatewayLoadout,
  store: RoutingReceiptStore,
): void {
  const sessionId = requireHookCoordinate(input.sessionId, "sessionId");
  const promptId = requireHookCoordinate(input.promptId, "promptId");
  const routingNonce = requireHookCoordinate(input.routingNonce, "routingNonce");
  ensureRoutingReceiptRoot(store.root);
  const receiptPath = path.join(store.root, `${receiptKey(sessionId, routingNonce)}.json`);
  const temporaryPath = `${receiptPath}.${process.pid}.tmp`;
  const receipt = JSON.stringify({
    promptId,
    agentTypes: allAgentTypes(loadout),
    modelIds: allModelIds(loadout),
  });
  let fd: number | undefined;
  try {
    fd = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      ROUTING_RECEIPT_MODE,
    );
    writeFileSync(fd, receipt, { encoding: "utf8" });
    closeSync(fd);
    fd = undefined;
    try {
      renameSync(temporaryPath, receiptPath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      // Windows rename does not replace an existing target. PreToolUse normally removed it;
      // this fallback covers crash recovery without weakening the POSIX atomic replace path.
      rmSync(receiptPath, { force: true });
      renameSync(temporaryPath, receiptPath);
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function ensureRoutingReceiptRoot(root: string): void {
  try {
    const stat = lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Routing receipt root is unsafe: ${root}`);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    mkdirSync(root, { mode: ROUTING_RECEIPT_DIR_MODE });
  }
  chmodSync(root, ROUTING_RECEIPT_DIR_MODE);
}

function receiptKey(sessionId: string, routingNonce: string): string {
  return [sessionId, routingNonce]
    .map((part) => Buffer.from(part, "utf8").toString("base64url"))
    .join(".");
}

function requireHookCoordinate(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`gateway_models hook mode requires ${name}`);
  }
  return value;
}

function allAgentTypes(loadout: GatewayLoadout): string[] {
  return Object.values(loadout.providers)
    .flatMap((provider) => provider.models)
    .flatMap((model) => Object.values(model.agentTypes));
}

function allModelIds(loadout: GatewayLoadout): string[] {
  return Object.values(loadout.providers)
    .flatMap((provider) => provider.models)
    .map((model) => model.modelId);
}

function routingContext(loadout: GatewayLoadout): string {
  return [
    "Use this fresh gateway roster for the handoff. Do not reuse an earlier reading or guess an identity.",
    "Agent: choose a resolvable agentTypes value and copy it to subagent_type.",
    "Workflow: choose a modelId and copy it verbatim to every agent() stage's opts.model.",
    "The two spellings are not interchangeable. If no suitable identity is usable, keep the work on the host or report the blocked handoff.",
    JSON.stringify(loadout),
  ].join("\n");
}

async function resolveLoadout(deps: GatewayModelsToolDeps): Promise<GatewayLoadout> {
  const selection = await deps.readSelection();
  // A failed allowance read must not sink the roster: constraints — the
  // capability class included — are still the larger part of the decision, and
  // reporting `unsupported` states the gap instead of implying room.
  let quota: GatewayQuotaSnapshot | undefined;
  try {
    quota = await deps.readQuota?.();
  } catch {
    quota = undefined;
  }
  return buildGatewayLoadout({
    exposed: selection.models,
    ...(selection.effortExposure ? { effortExposure: selection.effortExposure } : {}),
    ...(selection.providerPriority ? { providerPriority: selection.providerPriority } : {}),
    ...(quota ? { quota } : {}),
  });
}
