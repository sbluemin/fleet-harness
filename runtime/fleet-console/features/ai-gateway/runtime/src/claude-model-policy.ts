import { findClaudeGatewayModel as findGatewayModel, GATEWAY_MODEL_ALIAS_PREFIX, toClaudeGatewayModelId, buildAnthropicModelList } from "./downstream/harness/claude-code/discovery.js";

const NATIVE_FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;
/** 네 가족의 정준 실행 alias(`sonnet[1m]`)와 하위 호환 입력(bare `sonnet`). 둘 다 1M 정준 alias로 실행한다. */
const NATIVE_MODEL_ALIASES = new Set(NATIVE_FAMILIES.flatMap((family) => [`${family}[1m]`, family]));

/** SDK는 실행을, Gateway는 모델 검증·별칭·discovery 의미를 소유한다. */
export const claudeGatewayModelPolicy = {
  resolve(requested: string): { readonly id: string; readonly discovery?: { readonly id: string; readonly display_name: string } } {
    if (typeof requested !== "string" || requested.trim().length === 0) {
      throw new TypeError("A model id must be a non-empty string.");
    }
    const model = findGatewayModel(requested);
    if (model && model.provider !== "claude") {
      const id = toClaudeGatewayModelId(model);
      const discovery = buildAnthropicModelList([model]).data.find((entry) => entry.id === id);
      if (!discovery) throw new Error(`Missing model discovery entry: ${id}`);
      return { id, discovery: { id: discovery.id, display_name: discovery.display_name } };
    }
    // 네이티브 Claude 가족은 bare·scoped·`[1m]` 어느 표기로 와도 가족의 단일 1M alias로 실행한다.
    if (model) return { id: toClaudeGatewayModelId(model) };
    if (requested.startsWith(GATEWAY_MODEL_ALIAS_PREFIX)) throw new TypeError(`Unknown gateway model: ${requested}`);
    // 명시적 `claude-*`/`anthropic*` 원문 모델은 가족 alias가 아니므로 그대로 중계한다.
    if (!/^(claude|anthropic)/i.test(requested) && !NATIVE_MODEL_ALIASES.has(requested.toLowerCase())) {
      throw new TypeError(`Not a gateway alias and not a native Anthropic model: ${requested}. Gateway models start with "${GATEWAY_MODEL_ALIAS_PREFIX}"; native models start with "claude" or "anthropic", or are one of: ${[...NATIVE_MODEL_ALIASES].join(", ")}.`);
    }
    return { id: requested };
  },
};
