import { clampReasoningEffort, type ReasoningEffort } from "../canonical/index.js";
import {
  GATEWAY_MODELS,
  findGatewayModel,
  upstreamModelId,
  type GatewayModel,
  type GatewayReasoningEffort,
} from "../models.js";

/**
 * Reasoning levels Cloud Code Assist accepts in
 * `generationConfig.thinkingConfig.thinkingLevel`.
 *
 * Exactly three, measured against the live wire on 2026-08-22: `minimal` is
 * refused per-model ("Thinking level MINIMAL is not supported for this model")
 * and `max` is refused by the enum itself ("Invalid value at
 * 'request.generation_config.thinking_config.thinking_level'"). Anything above
 * `high` on Fleet's ladder therefore clamps onto `high` rather than reaching the
 * wire and failing the turn.
 */
export const ANTIGRAVITY_THINKING_LEVELS = ["low", "medium", "high"] as const;

export type AntigravityThinkingLevel = typeof ANTIGRAVITY_THINKING_LEVELS[number];

export interface AntigravityModelSelection {
  /** The exact id the CCA envelope's `model` field carries. */
  readonly wireModelId: string;
  /** Set only where the wire honours it; absent means send no `thinkingConfig`. */
  readonly thinkingLevel?: AntigravityThinkingLevel;
}

function thinkingLevel(effort: ReasoningEffort): AntigravityThinkingLevel {
  if (effort === "low" || effort === "minimal") return "low";
  if (effort === "medium") return "medium";
  return "high";
}

/**
 * Resolve one catalog model plus a requested effort to what the wire receives.
 *
 * Antigravity spells effort two ways and the catalog says which one a model uses:
 *
 * - **Id-encoded** — the entry declares `effort.upstreamModelIds`, so the rung is
 *   part of the model id and no `thinkingConfig` is sent. Gemini 3.1 Pro works
 *   this way, and it is also why `gemini-3.1-pro-high` never reaches the wire:
 *   upstream refuses it (`INVALID_ARGUMENT`) and its own `deprecatedModelIds`
 *   names `gemini-pro-agent` as the replacement.
 * - **Request-field** — the entry declares levels with no id overrides, so one
 *   wire id carries every rung and `thinkingConfig.thinkingLevel` selects it.
 *   Gemini 3.7 Flash works this way, on the `-tiered` id: measured 2026-08-22 it
 *   spent 343 / 407 / 434 reasoning tokens on one prompt across low/medium/high.
 *
 * A model with no ladder gets neither, and that gate is load-bearing rather than
 * cosmetic. Measured 2026-08-22 on the same backend, `gpt-oss-120b-medium`
 * rejects `thinkingConfig` outright with `INVALID_ARGUMENT`, and Claude ignores
 * it (low, high, and absent returned byte-identical usage). Only a model whose
 * catalog entry declares a ladder may be sent one.
 */
export function resolveAntigravityModelSelection(
  modelId: string,
  requestedEffort?: ReasoningEffort,
  catalog: readonly GatewayModel[] = GATEWAY_MODELS,
): AntigravityModelSelection {
  const model = findGatewayModel(modelId, catalog)
    ?? catalog.find((candidate) =>
      candidate.provider === "antigravity" && upstreamModelId(candidate) === modelId);
  if (!model || model.provider !== "antigravity") return { wireModelId: modelId };

  const baseId = upstreamModelId(model);
  if (!model.effort.supported) return { wireModelId: baseId };

  // Claude Code states an effort on every turn, but a caller that omits one is
  // held to the same session default the client uses, then clamped downward into
  // the model's own ladder.
  const effort = clampReasoningEffort(
    requestedEffort ?? "high",
    model.effort.levels,
    baseId,
  ) as GatewayReasoningEffort;

  const exactModelId = model.effort.upstreamModelIds?.[effort]
    ?? model.effort.upstreamModelIdTemplate?.replace("{effort}", effort);
  if (exactModelId) return { wireModelId: exactModelId };
  return { wireModelId: baseId, thinkingLevel: thinkingLevel(effort) };
}
