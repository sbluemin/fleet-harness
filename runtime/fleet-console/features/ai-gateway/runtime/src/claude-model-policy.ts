import { findClaudeGatewayModel as findGatewayModel, GATEWAY_MODEL_ALIAS_PREFIX, toClaudeGatewayModelId, buildAnthropicModelList } from "./downstream/harness/claude-code/discovery.js";

const NATIVE_MODEL_ALIASES = new Set(["sonnet", "opus", "opus[1m]", "haiku", "fable", "fable[1m]"]);

/** SDK는 실행을, Gateway는 모델 검증·별칭·discovery 의미를 소유한다. */
export const claudeGatewayModelPolicy = {
  resolve(requested: string): { readonly id: string; readonly discovery?: { readonly id: string; readonly display_name: string } } {
    if (typeof requested !== "string" || requested.trim().length === 0) {
      throw new TypeError("A model id must be a non-empty string.");
    }
    const model = findGatewayModel(requested);
    if (model) {
      const id = toClaudeGatewayModelId(model);
      const discovery = buildAnthropicModelList([model]).data.find((entry) => entry.id === id);
      if (!discovery) throw new Error(`Missing model discovery entry: ${id}`);
      return { id, discovery: { id: discovery.id, display_name: discovery.display_name } };
    }
    if (requested.startsWith(GATEWAY_MODEL_ALIAS_PREFIX)) throw new TypeError(`Unknown gateway model: ${requested}`);
    if (!/^(claude|anthropic)/i.test(requested) && !NATIVE_MODEL_ALIASES.has(requested.toLowerCase())) {
      throw new TypeError(`Not a gateway alias and not a native Anthropic model: ${requested}. Gateway models start with "${GATEWAY_MODEL_ALIAS_PREFIX}"; native models start with "claude" or "anthropic", or are one of: ${[...NATIVE_MODEL_ALIASES].join(", ")}.`);
    }
    return { id: requested };
  },
};
