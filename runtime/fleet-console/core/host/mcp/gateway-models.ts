import type { GatewayModel, GatewayProvider } from "@dotobokuri/core-ai-gateway";

import {
  buildGatewayLoadout,
  type GatewayEffortExposure,
  type GatewayLoadout,
  type GatewayQuotaSnapshot,
} from "@dotobokuri/fleet-admiral";

export interface GatewayModelsSelection {
  /** Exactly the delegable models the user exposed — the exposed set minus the ones reserved for the host session. Never the whole catalog. */
  readonly models: readonly GatewayModel[];
  /** Per-model reasoning rungs the user exposed. Absent entry = that model's whole ladder. */
  readonly effortExposure?: GatewayEffortExposure;
  /** The user's opt-in ordered spend preference across providers; weights the allowance axis only. */
  readonly providerPriority?: readonly GatewayProvider[];
}

export interface GatewayModelsDeps {
  /** Read at call time; the exposed set is user-editable while a session runs. */
  readonly readSelection: () => Promise<GatewayModelsSelection> | GatewayModelsSelection;
  /** Omitted when the host cannot read allowances; every provider then reports `unsupported`. */
  readonly readQuota?: () => Promise<GatewayQuotaSnapshot | undefined> | GatewayQuotaSnapshot | undefined;
}

export async function resolveGatewayLoadout(deps: GatewayModelsDeps): Promise<GatewayLoadout> {
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
