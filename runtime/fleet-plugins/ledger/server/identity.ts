export const LEDGER_LAUNCH_PROVIDERS = ["claude", "codex", "cursor", "kimi", "opencode", "xai"] as const;
export type LedgerLaunchProvider = (typeof LEDGER_LAUNCH_PROVIDERS)[number];

export const GATEWAY_MODEL_PREFIX = "claude-gateway--";
export const NATIVE_SUPPLIER = "native";

const PROVIDER_SET = new Set<string>(LEDGER_LAUNCH_PROVIDERS);

export function isLaunchProvider(value: unknown): value is LedgerLaunchProvider {
  return typeof value === "string" && PROVIDER_SET.has(value);
}

export function readLaunchProvider(payload: Readonly<Record<string, unknown>>): LedgerLaunchProvider | null {
  return isLaunchProvider(payload.launchProvider) ? payload.launchProvider : null;
}

export interface ModelIdentity {
  readonly modelId: string;
  readonly supplier: string;
  readonly bare: string;
  readonly label: string;
}

/** Strip the published Gateway alias and name the supplier + bare model. */
export function parseModelIdentity(modelId: string): ModelIdentity {
  let rest = modelId;
  let supplier = NATIVE_SUPPLIER;
  if (rest.startsWith(GATEWAY_MODEL_PREFIX)) {
    rest = rest.slice(GATEWAY_MODEL_PREFIX.length);
    const separator = rest.indexOf("--");
    if (separator > 0) {
      const candidate = rest.slice(0, separator);
      if (PROVIDER_SET.has(candidate)) {
        supplier = candidate;
        rest = rest.slice(separator + 2);
      }
    }
  } else {
    const inferred = inferUnprefixedSupplier(rest);
    supplier = inferred.supplier;
    rest = inferred.bare;
  }
  return {
    modelId,
    supplier,
    bare: rest,
    label: humanizeBareModel(rest),
  };
}

/**
 * tokscale report `models_used` and some models-command rows omit the Gateway prefix.
 * Claude-shaped ids stay Claude; slash-prefixed and well-known bare ids name their supplier.
 * Leftovers stay `native` — the client must not paint that bucket as Claude.
 */
function inferUnprefixedSupplier(modelId: string): { supplier: string; bare: string } {
  const slash = modelId.indexOf("/");
  if (slash > 0) {
    const candidate = modelId.slice(0, slash).toLowerCase();
    if (PROVIDER_SET.has(candidate)) {
      return { supplier: candidate, bare: modelId.slice(slash + 1) };
    }
  }
  const lower = modelId.toLowerCase();
  if (lower.startsWith("claude")) return { supplier: "claude", bare: modelId };
  if (lower.startsWith("gpt-")) return { supplier: "codex", bare: modelId };
  if (lower.startsWith("grok")) return { supplier: "xai", bare: modelId };
  if (lower.startsWith("kimi")) return { supplier: "kimi", bare: modelId };
  return { supplier: NATIVE_SUPPLIER, bare: modelId };
}

/**
 * tokscale `models` hyphenates version dots (`gpt-5.6` → `gpt-5-6`).
 * Collapse that pair so a report id and a models id can share a key.
 */
export function normalizeModelKey(modelId: string): string {
  return parseModelIdentity(modelId).bare
    .toLowerCase()
    .replace(/\bgpt-(\d)-(\d)\b/g, "gpt-$1.$2");
}

export function markKeyFromIdentity(launchProvider: string | null | undefined, cliId: string): string {
  if (isLaunchProvider(launchProvider)) return launchProvider;
  if (cliId === "claude-gateway") return "claude";
  return cliId;
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
  const joined = words.join(" ").replace(/\bGPT (\d) (\d)\b/g, "GPT $1.$2");
  return bracketMillion || trailingMillion ? `${joined} (1M)` : joined;
}
