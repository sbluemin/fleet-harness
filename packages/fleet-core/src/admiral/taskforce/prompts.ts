/**
 * fleet/shipyard/taskforce/prompts.ts — carrier_taskforce 도구 프롬프트 / 스키마 관리
 *
 * carrier_taskforce 도구 등록에 필요한 모든 프롬프트 메타데이터와
 * TypeBox 파라미터 스키마를 한 곳에서 조립합니다.
 */

import { Type, type TObject } from "@sinclair/typebox";
import { CLI_DISPLAY_NAMES } from "../../constants.js";
import type { ToolPromptManifest } from "../../infra/tool-registry/index.js";
import {
  deriveToolDescription,
  deriveToolPromptGuidelines,
  deriveToolPromptSnippet,
} from "../../infra/tool-registry/index.js";
import { TASKFORCE_CLI_TYPES } from "./types.js";

// ─────────────────────────────────────────────────────────
// 1. 상수 프롬프트
// ─────────────────────────────────────────────────────────

/**
 * carrier_taskforce 도구 설명 (Tool Schema — LLM이 도구 선택 시 참조).
 */
const TASKFORCE_BACKEND_LABELS = TASKFORCE_CLI_TYPES
  .map((cliType) => CLI_DISPLAY_NAMES[cliType] ?? cliType)
  .join(", ");

const TASKFORCE_CONFIGURE_HINT =
  `open Carrier Status (Alt+O) and press T to configure at least two CLI backends (${TASKFORCE_BACKEND_LABELS})`;

export const TASKFORCE_MANIFEST: ToolPromptManifest = {
  id: "carrier_taskforce",
  tag: "carrier_taskforce",
  title: "carrier_taskforce Tool Guidelines",
  description:
    `Register a fire-and-forget job to cross-validate a carrier's response across the carrier's configured CLI backends (≥2) simultaneously.` +
    ` Runs the same task under the chosen carrier's persona on each configured backend and returns a job_id immediately.` +
    ` Use this when you need to compare approaches, detect blind spots, or build consensus across models.`,
  promptSnippet:
    `carrier_taskforce — Register cross-backend validation jobs. Results arrive later via [carrier:result]; carrier_jobs is fallback/explicit lookup only.`,
  whenToUse: [
    "Use carrier_taskforce when cross-model validation is needed: comparing solution approaches, catching model-specific blind spots, building consensus, or when a single backend may be insufficient.",
    "Pick the carrier whose role or persona best fits the task.",
  ],
  whenNotToUse: [
    "Do NOT use carrier_taskforce for routine single-backend tasks — use the carrier's individual tool (`carrier_<id>`) instead.",
    "Avoid it when only one backend is needed or when execution speed is critical.",
    "Do not use as a substitute for individual carrier tools when a single carrier suffices.",
  ],
  usageGuidelines: [
    `The carrier parameter selects which carrier's role and prompt context to apply.` +
      ` Each carrier's configured backends (≥2) will execute the same request under that persona.`,
    `The launch response is { job_id, accepted, error? } and never includes synchronous result content.` +
      ` Results arrive by [carrier:result] push, labelled by backend name; carrier_jobs is fallback/explicit lookup only.` +
      ` Each backend runs independently — a failure in one does not abort the others.`,
    `Do not poll, wait-check, or call carrier_jobs merely to see whether the job is done.` +
      ` Continue independent work if available; otherwise stop tool use and wait passively for the [carrier:result] follow-up push.`,
    `Structure each carrier request using that carrier's required tags listed in <fleet section="roster">; missing required tags cause hard-error rejection by the dispatcher.`,
  ],
};

export const FLEET_TASKFORCE_DESCRIPTION = deriveToolDescription(TASKFORCE_MANIFEST);

// ─────────────────────────────────────────────────────────
// 2. Build 함수
// ─────────────────────────────────────────────────────────

/** carrier_taskforce의 `promptSnippet` 값을 반환합니다. */
export function buildTaskForcePromptSnippet(): string {
  return deriveToolPromptSnippet(TASKFORCE_MANIFEST);
}

/**
 * carrier_taskforce의 `promptGuidelines` 배열을 반환합니다.
 *
 * @param configuredCarrierIds TF 편성이 가능한 carrier ID 목록
 */
export function buildTaskForcePromptGuidelines(configuredCarrierIds: string[]): string[] {
  if (configuredCarrierIds.length === 0) {
    return deriveToolPromptGuidelines(TASKFORCE_MANIFEST, [
      `## Task Force Carriers\nNo carriers currently meet the Task Force ≥2 backend requirement.` +
      ` To configure, ${TASKFORCE_CONFIGURE_HINT}.`,
    ]);
  }
  return deriveToolPromptGuidelines(TASKFORCE_MANIFEST, []);
}

/**
 * carrier_taskforce의 TypeBox `parameters` 스키마를 반환합니다.
 *
 * @param configuredCarrierIds TF 편성이 가능한 carrier ID 목록
 */
export function buildTaskForceSchema(configuredCarrierIds: string[]): TObject {
  const availableDesc =
    configuredCarrierIds.length > 0
      ? `Carrier ID whose persona to apply. Available: ${configuredCarrierIds.join(", ")}`
      : `Carrier ID whose persona to apply. (No carriers currently meet the Task Force ≥2 backend requirement — ${TASKFORCE_CONFIGURE_HINT})`;

  return Type.Object({
    carrier: Type.String({ description: availableDesc }),
    request: Type.String({
      description: "The task/prompt to cross-validate across the carrier's configured CLI backends",
    }),
  });
}
