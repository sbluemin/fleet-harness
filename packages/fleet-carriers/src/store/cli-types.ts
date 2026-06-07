import { CLI_BACKENDS, type CliType } from "@dotobokuri/core-unified-agent";
import { disconnect } from "@dotobokuri/core-agent";

import {
  sanitizeAgentCli,
  sanitizeAgentCliSelectionForCliType,
  sanitizeAgentCliType,
  sanitizeConfigKey,
} from "./sanitize.js";
import { readRawCarriers, updateCarriers } from "./state-io.js";
import type { AgentCliSelection } from "./types.js";

const VALID_CLI_TYPES = new Set(Object.keys(CLI_BACKENDS));

export function loadAgentCliTypeOverrides(validIds?: Set<string>): Record<string, string> {
  const carriers = readRawCarriers().carriers ?? {};
  const overrides = Object.fromEntries(
    Object.entries(carriers)
      .filter(([, state]) => state.agentCliType)
      .map(([id, state]) => [id, state.agentCliType!]),
  );
  if (!validIds) return overrides;
  return Object.fromEntries(
    Object.entries(overrides).filter(([id]) => validIds.has(id)),
  );
}

export function resolveAgentCliType(carrierId: string, defaultCliType: CliType): CliType {
  return readRawCarriers().carriers?.[carrierId]?.agentCliType ?? defaultCliType;
}

export function updateAgentCliTypeOverride(
  carrierId: string,
  cliType: string,
  defaultCliType: string,
): void {
  const sanitizedCarrierId = sanitizeConfigKey(carrierId);
  const sanitizedCliType = sanitizeAgentCliType(cliType);
  if (!sanitizedCarrierId || !sanitizedCliType || !VALID_CLI_TYPES.has(defaultCliType)) return;

  updateCarriers((states) => {
    const carriers = { ...(states.carriers ?? {}) };
    const current = carriers[sanitizedCarrierId] ?? {};
    if (cliType === defaultCliType) {
      const next = { ...current };
      delete next.agentCliType;
      carriers[sanitizedCarrierId] = next;
    } else {
      carriers[sanitizedCarrierId] = { ...current, agentCliType: sanitizedCliType };
    }
    states.carriers = carriers;
  });
}

export async function applyAgentCliTypeSelectionUpdate(
  carrierId: string,
  nextCliType: CliType,
  defaultCliType: CliType,
  previousCliType: CliType | null,
  previousSelection: AgentCliSelection | undefined,
  selection: AgentCliSelection,
): Promise<void> {
  updateCarriers((states) => {
    const carriers = { ...(states.carriers ?? {}) };
    const current = carriers[carrierId] ?? {};
    const agentCli = { ...sanitizeAgentCli(current.agentCli) };
    if (previousCliType && previousSelection) {
      const sanitizedPrevious = sanitizeAgentCliSelectionForCliType(previousCliType, previousSelection);
      if (sanitizedPrevious) agentCli[previousCliType] = sanitizedPrevious;
    }
    const sanitizedSelection = sanitizeAgentCliSelectionForCliType(nextCliType, selection);
    if (sanitizedSelection) agentCli[nextCliType] = sanitizedSelection;
    carriers[carrierId] = {
      ...current,
      ...(nextCliType === defaultCliType ? {} : { agentCliType: nextCliType }),
      agentCli,
    };
    if (nextCliType === defaultCliType) delete carriers[carrierId].agentCliType;
    states.carriers = carriers;
  });
  await disconnect(carrierId);
}
