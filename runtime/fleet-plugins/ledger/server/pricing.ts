import { GATEWAY_MODEL_PRICING, type GatewayModelPricing } from "@dotobokuri/core-ai-gateway";

import { GATEWAY_MODEL_PREFIX, parseModelIdentity } from "./identity.js";
import type { TokscaleModelEntry } from "./types.js";

function canonicalPricingAlias(modelId: string): string {
  return modelId
    .toLowerCase()
    .replace(/\[1m\]$/i, "")
    .replace(/-fast$/, "")
    .replace(/-1m$/, "")
    .replace(/-256k$/, "")
    .replace(/\b(\d+)-(\d+)\b/g, "$1.$2");
}

function findGatewayPricing(modelId: string): GatewayModelPricing | undefined {
  const alias = canonicalPricingAlias(parseModelIdentity(modelId).bare);
  return Object.values(GATEWAY_MODEL_PRICING).find((pricing) => pricing.aliases.includes(alias));
}

function staticGatewayCost(entry: TokscaleModelEntry): number | null {
  if (!entry.modelId.startsWith(GATEWAY_MODEL_PREFIX)) return null;
  const pricing = findGatewayPricing(entry.modelId);
  if (!pricing) return null;
  return (
    entry.input * pricing.inputCostPerToken
    + entry.output * pricing.outputCostPerToken
    + entry.cacheRead * pricing.cacheReadInputTokenCost
    + entry.cacheWrite * (pricing.cacheCreationInputTokenCost ?? pricing.inputCostPerToken)
  );
}

/** Reprice Gateway aliases from the static registry; preserve tokscale cost when OpenRouter has no entry. */
export function applyGatewayPricing(entry: TokscaleModelEntry): TokscaleModelEntry {
  const costUsd = staticGatewayCost(entry);
  return costUsd === null ? entry : { ...entry, costUsd };
}
