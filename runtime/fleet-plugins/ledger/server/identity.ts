export const GATEWAY_MODEL_PREFIX = "claude-gateway--";
export const ANTHROPIC_PROVIDER = "anthropic";
export const UNKNOWN_PROVIDER = "unknown";

const PROVIDER_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface ModelIdentity {
  readonly modelId: string;
  readonly provider: string;
  readonly bare: string;
  readonly label: string;
}

/** Distinguish native Anthropic ids from the provider encoded in a Gateway alias. */
export function parseModelIdentity(modelId: string): ModelIdentity {
  if (modelId.startsWith(GATEWAY_MODEL_PREFIX)) {
    const gatewayIdentity = modelId.slice(GATEWAY_MODEL_PREFIX.length);
    const separator = gatewayIdentity.indexOf("--");
    if (separator > 0) {
      const provider = gatewayIdentity.slice(0, separator).toLowerCase();
      const bare = gatewayIdentity.slice(separator + 2);
      if (PROVIDER_RE.test(provider) && bare.length > 0) {
        return { modelId, provider, bare, label: humanizeBareModel(bare) };
      }
    }
  }

  const provider = modelId.startsWith("claude-") ? ANTHROPIC_PROVIDER : UNKNOWN_PROVIDER;
  return { modelId, provider, bare: modelId, label: humanizeBareModel(modelId) };
}

function canonicalBareModel(bare: string): string {
  return bare
    .toLowerCase()
    .replace(/-fast(?=\[1m\]$|$)/, "")
    .replace(/\bgpt-(\d)-(\d)\b/g, "gpt-$1.$2");
}

/** Keep providers distinct while joining tokscale variants and each provider's Fast tier. */
export function normalizeModelKey(modelId: string): string {
  const identity = parseModelIdentity(modelId);
  return `${identity.provider}\u0000${canonicalBareModel(identity.bare)}`;
}

/** Display a merged Fast tier under the base model name. */
export function canonicalModelIdentity(modelId: string): ModelIdentity {
  const identity = parseModelIdentity(modelId);
  if (!/-fast(?:\[1m\])?$/i.test(identity.bare)) return identity;
  const bare = identity.bare.replace(/-fast(?=\[1m\]$|$)/i, "");
  return {
    ...identity,
    modelId: identity.modelId.replace(/-fast(?=\[1m\]$|$)/i, ""),
    bare,
    label: humanizeBareModel(bare),
  };
}

export function humanizeBareModel(bare: string): string {
  const bracketMillion = /\[1m\]$/i.test(bare);
  const tokens = bare.replace(/\[1m\]$/i, "").split(/[-_]/).filter(Boolean);
  // 카탈로그 별칭은 `claude-opus-5-1m[1m]`처럼 하이픈 토큰과 괄호 접미사를 같이 쓴다.
  // 둘을 각각 살리면 "1m (1M)"이 겹친다 — 끝의 1m 토큰은 창 표식일 뿐 모델 이름 일부가 아니다.
  const trailingMillion = tokens.at(-1)?.toLowerCase() === "1m";
  const nameTokens = trailingMillion ? tokens.slice(0, -1) : tokens;
  const words = nameTokens.map((token) => {
    if (/^\d/.test(token)) return token;
    const lower = token.toLowerCase();
    if (lower === "gpt") return "GPT";
    return `${token.charAt(0).toUpperCase()}${token.slice(1)}`;
  });
  const joined = words.join(" ").replace(/\b(\d+) (\d+)\b/g, "$1.$2");
  return bracketMillion || trailingMillion ? `${joined} (1M)` : joined;
}
