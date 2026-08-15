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
  }
  return {
    modelId,
    supplier,
    bare: rest,
    label: humanizeBareModel(rest),
  };
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
  if (cliId === NATIVE_SUPPLIER) return "claude";
  return cliId;
}

export function humanizeBareModel(bare: string): string {
  const million = /\[1m\]$/i.test(bare);
  const stripped = bare.replace(/\[1m\]$/i, "");
  const tokens = stripped.split(/[-_]/).filter(Boolean);
  const words = tokens.map((token) => {
    if (/^\d/.test(token)) return token;
    const lower = token.toLowerCase();
    if (lower === "gpt") return "GPT";
    if (lower === "1m") return "1M";
    return `${token.charAt(0).toUpperCase()}${token.slice(1)}`;
  });
  const joined = words.join(" ").replace(/\bGPT (\d) (\d)\b/g, "GPT $1.$2");
  return million ? `${joined} (1M)` : joined;
}
