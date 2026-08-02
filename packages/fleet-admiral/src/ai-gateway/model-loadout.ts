/**
 * ai-gateway/model-loadout — the roster a host reads before assigning models to
 * workflow stages.
 *
 * Three layers meet here and stay distinguishable: catalog constraints (facts a
 * provider states), role fit (a judgement Fleet measured), and provider quota (a
 * reading taken at a moment). The host combines them; this module never decides
 * for it, because a roster that answered "use this one" would be followed
 * without the check that makes the choice defensible.
 */

import {
  GATEWAY_MODELS_UPDATED_AT,
  buildGatewayModelConstraints,
  gatewayModelIdentity,
  toClaudeGatewayModelId,
  type GatewayModel,
  type GatewayModelConstraints,
} from "@dotobokuri/core-ai-gateway";
import { createHash } from "node:crypto";

import { gatewayRoleFit, type GatewayRoleFit } from "./role-fit.js";

/** A provider allowance reading, shaped by the host that took it. */
export interface GatewayQuotaWindow {
  readonly id: string;
  /** Sub-pool this window measures; absent when it covers the whole allowance. */
  readonly scope?: string;
  readonly usedPercent: number;
  readonly resetsAt?: number;
}

export interface GatewayProviderQuota {
  readonly status: string;
  readonly windows?: readonly GatewayQuotaWindow[];
  readonly fetchedAt?: number;
}

/**
 * Quota keyed by provider id. `claude` is meaningful here even though it serves
 * no gateway model: it is the allowance an inherited (unpinned) stage spends,
 * and therefore the baseline any offload is measured against.
 */
export type GatewayQuotaSnapshot = Readonly<Record<string, GatewayProviderQuota>>;

export interface GatewayLoadoutModel {
  /** Exact string to pass through as a model id. */
  readonly id: string;
  readonly displayName: string;
  readonly constraints: GatewayModelConstraints;
  /** `null` means unmeasured, which is not the same as unsuitable. */
  readonly roleFit: GatewayRoleFit | null;
  readonly isSessionDefault: boolean;
}

export interface GatewayLoadoutProvider {
  readonly id: string;
  /**
   * `unsupported` means Fleet has no way to read this provider's allowance —
   * never that the allowance is healthy.
   */
  readonly quota: GatewayProviderQuota | { readonly status: "unsupported" };
}

export interface GatewayLoadout {
  /**
   * Changes when the exposed set or the catalog changes. A host that pinned
   * models under one revision can tell its roster went out of date.
   */
  readonly revision: string;
  readonly catalogUpdatedAt: string;
  readonly models: readonly GatewayLoadoutModel[];
  readonly providers: readonly GatewayLoadoutProvider[];
}

export interface BuildGatewayLoadoutInput {
  /** Exactly the models the user exposed. Never the whole catalog. */
  readonly exposed: readonly GatewayModel[];
  readonly defaultModel?: GatewayModel;
  readonly quota?: GatewayQuotaSnapshot;
}

const UNSUPPORTED_QUOTA = Object.freeze({ status: "unsupported" as const });

export function buildGatewayLoadout(input: BuildGatewayLoadoutInput): GatewayLoadout {
  const models = input.exposed.map((model) => toLoadoutModel(model, input.defaultModel));
  return {
    revision: loadoutRevision(models),
    catalogUpdatedAt: GATEWAY_MODELS_UPDATED_AT,
    models,
    providers: buildProviders(input.exposed, input.quota),
  };
}

function toLoadoutModel(model: GatewayModel, defaultModel?: GatewayModel): GatewayLoadoutModel {
  return {
    id: toClaudeGatewayModelId(model),
    displayName: model.displayName,
    constraints: buildGatewayModelConstraints(model),
    roleFit: gatewayRoleFit(gatewayModelIdentity(model)) ?? null,
    isSessionDefault: defaultModel !== undefined && defaultModel.id === model.id,
  };
}

function buildProviders(
  exposed: readonly GatewayModel[],
  quota: GatewayQuotaSnapshot | undefined,
): readonly GatewayLoadoutProvider[] {
  const ids: string[] = [];
  for (const model of exposed) {
    if (!ids.includes(model.provider)) ids.push(model.provider);
  }
  // The parent session's own allowance is reported even with no gateway model
  // behind it, because offloading is only justified against that baseline.
  for (const id of Object.keys(quota ?? {})) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids.map((id) => ({ id, quota: quota?.[id] ?? UNSUPPORTED_QUOTA }));
}

// Quota is deliberately excluded: it moves on its own and would make every
// reading look like a roster change, hiding the exposure edits that matter.
function loadoutRevision(models: readonly GatewayLoadoutModel[]): string {
  const material = [
    GATEWAY_MODELS_UPDATED_AT,
    ...models.map((model) => `${model.id}:${model.isSessionDefault ? "1" : "0"}`).sort(),
  ].join("\n");
  return createHash("sha256").update(material).digest("hex").slice(0, 12);
}
