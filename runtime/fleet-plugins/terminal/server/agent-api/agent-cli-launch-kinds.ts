import type { OperationLaunchKind, OperationLaunchVariantGroup } from "@fleet-console/sdk/operations";
import { exposableEffortLadder, type AiGatewaySelection } from "@dotobokuri/core-ai-gateway";
import { NATIVE_CLAUDE_EFFORTS, NATIVE_CLAUDE_MODEL_ALIASES } from "@dotobokuri/fleet-admiral";

import type { AgentCliLaunchMetadata } from "./agent-cli-launch-metadata.js";

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  low: "LOW",
  medium: "MED",
  high: "HIGH",
  xhigh: "XHIGH",
  max: "MAX",
};

const NATIVE_MODEL_LABELS: Readonly<Record<(typeof NATIVE_CLAUDE_MODEL_ALIASES)[number], string>> = {
  fable: "Fable",
  opus: "Opus",
  sonnet: "Sonnet",
};

export function buildAgentCliLaunchKinds(
  metadata: readonly AgentCliLaunchMetadata[],
  operationType: string,
  gatewaySelection?: AiGatewaySelection,
): OperationLaunchKind[] {
  return metadata
    .map((cli) => {
      const disabledReason = resolveDisabledReason(cli);
      return {
        id: cli.id,
        type: operationType,
        title: cli.label,
        ...(disabledReason
          ? { disabled: true, disabledReason }
          : cli.id === "claude-gateway"
            ? { variants: buildClaudeGatewayLaunchVariants(gatewaySelection) }
            : {}),
      };
    });
}

export function buildClaudeGatewayLaunchVariants(selection?: AiGatewaySelection): readonly OperationLaunchVariantGroup[] {
  const native: OperationLaunchVariantGroup = {
    id: "native",
    label: "Claude",
    rows: NATIVE_CLAUDE_MODEL_ALIASES.map((model) => ({
      id: model,
      label: NATIVE_MODEL_LABELS[model],
      launch: { model },
      chips: NATIVE_CLAUDE_EFFORTS.map((effort) => ({
        id: effort,
        label: EFFORT_LABELS[effort]!,
        launch: { model, effort },
      })),
    })),
  };
  if (!selection || selection.models.length === 0) return [native];
  return [native, {
    id: "gateway",
    label: "Gateway",
    rows: selection.models.map((model) => {
      const efforts = (selection.effortExposure[model.id] ?? exposableEffortLadder(model))
        .filter((effort): effort is (typeof NATIVE_CLAUDE_EFFORTS)[number] =>
          NATIVE_CLAUDE_EFFORTS.includes(effort as (typeof NATIVE_CLAUDE_EFFORTS)[number]));
      return {
        id: model.id,
        label: model.displayName,
        ...(selection.defaultModel?.id === model.id ? { starred: true } : {}),
        launch: { model: model.id },
        ...(efforts.length > 0 ? {
          chips: efforts.map((effort) => ({
            id: effort,
            label: EFFORT_LABELS[effort] ?? effort.toUpperCase(),
            launch: { model: model.id, effort },
          })),
        } : {}),
      };
    }),
  }];
}

function resolveDisabledReason(cli: AgentCliLaunchMetadata): string | undefined {
  if (!cli.available) return "Not installed";
  if (!cli.signedIn) return "Sign in required";
  return undefined;
}
