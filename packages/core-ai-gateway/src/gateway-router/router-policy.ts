import {
  CLAUDE_SEARCH_TOOL_NAMES,
  omitClaudeClientTools,
  omitClaudeWebSearchTools,
  pruneClaudeSkillPayloads,
  stripClaudeBashFirstDirective,
} from "../anthropic/claude-context.js";
import type { AnthropicMessagesRequest } from "../anthropic/protocol.js";
import type { GatewayModel, GatewayProvider } from "../models.js";
import { upstreamModelId } from "../models.js";
import { codexRequestPolicy } from "../codex/router-policy.js";
import { cursorRequestPolicy } from "../cursor/router-policy.js";
import { kimiRequestPolicy } from "../kimi/router-policy.js";
import { opencodeGoRequestPolicy } from "../opencode-go/router-policy.js";
import { xaiRequestPolicy } from "../xai/router-policy.js";

/**
 * What a provider knows about the request it is shaping.
 *
 * `withheldSkills` is the router's own set and outlives the request: a skill body
 * withheld once keeps its listing entry hidden for the rest of the connection.
 */
export interface GatewayPolicyContext {
  readonly target: GatewayModel;
  /** The upstream wire model id, for the skill estimator's token ratio. */
  readonly upstreamModel: string;
  readonly withheldSkills: Set<string>;
}

/**
 * The request-shaping steps a provider policy may apply.
 *
 * The implementations live here rather than in the provider folders on purpose: they
 * read Claude Code's own request vocabulary from `anthropic/claude-context.ts`, which
 * is the client-facing compatibility seam and not on the list of Anthropic modules a
 * provider folder may import. A provider states *which* steps its wire deserves; how
 * a step is performed stays with the seam that understands the client.
 */
export interface GatewayPolicySteps {
  /** Withhold skill bodies the target's window cannot afford, and delist them. */
  readonly pruneSkillPayloads: (request: AnthropicMessagesRequest) => AnthropicMessagesRequest;
  /** Withhold Claude Code's Web Search tools, in all three spellings. */
  readonly withholdWebSearchTools: (request: AnthropicMessagesRequest) => AnthropicMessagesRequest;
  /** Withhold Claude Code's `Grep`/`Glob` from the advertised catalog. */
  readonly withholdSearchTools: (request: AnthropicMessagesRequest) => AnthropicMessagesRequest;
  /** Withhold client tools by name; `tool_choice` pinned to one is downgraded to `auto`. */
  readonly withholdClientTools: (
    request: AnthropicMessagesRequest,
    names: Iterable<string>,
  ) => AnthropicMessagesRequest;
  /** Drop the client's shell-first directive so it cannot argue with the catalog. */
  readonly stripShellFirstDirective: (request: AnthropicMessagesRequest) => AnthropicMessagesRequest;
}

/**
 * One provider's answer to "what does my wire deserve to receive".
 *
 * Every gateway provider declares one. There is no default: a provider added without
 * a policy fails to compile rather than silently inheriting another provider's answer,
 * which is the same reason this package duplicates provider semantics elsewhere.
 */
export interface GatewayRequestPolicy {
  readonly provider: GatewayProvider;
  readonly shapeRequest: (
    request: AnthropicMessagesRequest,
    steps: GatewayPolicySteps,
    context: GatewayPolicyContext,
  ) => AnthropicMessagesRequest;
}

const POLICIES: Readonly<Record<GatewayProvider, GatewayRequestPolicy>> = {
  codex: codexRequestPolicy,
  cursor: cursorRequestPolicy,
  kimi: kimiRequestPolicy,
  // The provider id is `opencode`; its folder carries the `-go` subscription name.
  opencode: opencodeGoRequestPolicy,
  xai: xaiRequestPolicy,
};

/** The policy a gateway target's provider declared for itself. */
export function resolveGatewayRequestPolicy(provider: GatewayProvider): GatewayRequestPolicy {
  return POLICIES[provider];
}

/**
 * Run a target's own policy over a caller request.
 *
 * Native Anthropic traffic never reaches here — it carries no gateway target, and the
 * caller's request is forwarded byte for byte.
 */
export function applyGatewayRequestPolicy(
  request: AnthropicMessagesRequest,
  target: GatewayModel,
  withheldSkills: Set<string>,
): AnthropicMessagesRequest {
  const context: GatewayPolicyContext = {
    target,
    upstreamModel: upstreamModelId(target),
    withheldSkills,
  };
  const policy = resolveGatewayRequestPolicy(target.provider);
  return policy.shapeRequest(request, buildPolicySteps(context), context);
}

function buildPolicySteps(context: GatewayPolicyContext): GatewayPolicySteps {
  const withholdClientTools = (
    request: AnthropicMessagesRequest,
    names: Iterable<string>,
  ): AnthropicMessagesRequest => {
    const omitted = omitClaudeClientTools(request, names);
    return omitted.changed ? omitted.request : request;
  };
  return {
    pruneSkillPayloads: (request) => {
      const pruned = pruneClaudeSkillPayloads(request.messages, {
        ...(typeof context.target.contextWindow === "number"
          ? { contextWindow: context.target.contextWindow }
          : {}),
        model: context.upstreamModel,
        withheld: context.withheldSkills,
      });
      for (const skill of pruned.withheld) context.withheldSkills.add(skill.name);
      return pruned.changed ? { ...request, messages: [...pruned.messages] } : request;
    },
    withholdWebSearchTools: (request) => {
      const omitted = omitClaudeWebSearchTools(request);
      return omitted.changed ? omitted.request : request;
    },
    withholdSearchTools: (request) => withholdClientTools(request, CLAUDE_SEARCH_TOOL_NAMES),
    withholdClientTools,
    stripShellFirstDirective: (request) => {
      const stripped = stripClaudeBashFirstDirective(request.messages);
      return stripped.changed ? { ...request, messages: [...stripped.messages] } : request;
    },
  };
}
