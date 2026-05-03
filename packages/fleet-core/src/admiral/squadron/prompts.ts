/**
 * fleet/shipyard/squadron/prompts.ts — carrier_squadron 도구 프롬프트 / 스키마 관리
 *
 * carrier_squadron 도구 등록에 필요한 모든 프롬프트 메타데이터와
 * TypeBox 파라미터 스키마를 한 곳에서 조립합니다.
 */

import { Type, type TObject } from "@sinclair/typebox";
import type { ToolPromptManifest } from "../../services/tool-registry/index.js";
import {
  deriveToolDescription,
  deriveToolPromptGuidelines,
  deriveToolPromptSnippet,
} from "../../services/tool-registry/index.js";
import { SQUADRON_MAX_INSTANCES } from "./types.js";

// ─────────────────────────────────────────────────────────
// 1. 상수 프롬프트
// ─────────────────────────────────────────────────────────

/**
 * carrier_squadron 도구 설명 (Tool Schema — LLM이 도구 선택 시 참조).
 */
const SQUADRON_CONFIGURE_HINT =
  `open Carrier Status (Alt+O) and press S to enable squadron mode for a carrier`;

export const SQUADRON_MANIFEST: ToolPromptManifest = {
  id: "carrier_squadron",
  tag: "carrier_squadron",
  title: "carrier_squadron Tool Guidelines",
  description:
    `Register a fire-and-forget job that fans out subtasks to parallel instances of the same carrier for divide-and-conquer execution.` +
    ` It returns a job_id immediately; results arrive through [carrier:result] push; carrier_jobs is fallback/explicit lookup only.`,
  promptSnippet:
    `carrier_squadron — Register parallel same-carrier subtask jobs. Results arrive later via [carrier:result]; carrier_jobs is fallback/explicit lookup only.`,
  whenToUse: [
    "Use carrier_squadron when a task can be decomposed into independent subtasks that benefit from parallel execution on the same carrier type.",
    "Use it for analyzing multiple files independently, running the same check across different modules, or batch-processing items.",
  ],
  whenNotToUse: [
    "Do NOT use carrier_squadron for tasks requiring sequential or dependent execution — use carriers_sortie for serial delegation.",
    "Do not use for cross-model comparison — use carrier_taskforce instead.",
    "Do not use when subtasks have data dependencies on each other.",
  ],
  usageGuidelines: [
    `The carrier parameter selects which carrier to fan out.` +
      ` All instances inherit the base carrier's persona, model, and settings.`,
    `expected_subtask_count must exactly match the subtasks array length — mismatches cause a hard error.` +
      ` Maximum ${SQUADRON_MAX_INSTANCES} subtasks allowed.`,
    `Each subtask request must still follow the selected carrier's request-tag contract.` +
      ` Preserve ordinary direct request composition when no optional planning artifact is available.`,
    `If Kirov has already produced a plan file for Ohio, pass that path via Ohio's optional \`<plan_file>\` tag inside the relevant subtask request instead of re-describing the full plan inline.` +
      ` That path must stay repo-relative and must point only to a Markdown plan under .fleet/plans/*.md.` +
      ` If no such file exists, preserve ordinary Genesis subtask request composition by sending only the normal objective/scope/constraints context.`,
    `Do not pass absolute paths, general repo-relative files, or non-Markdown files via Ohio's \`<plan_file>\` tag in carrier_squadron subtasks.` +
      ` If a provided \`<plan_file>\` is missing, unreadable, or invalid, Ohio must report the issue and request re-direction rather than guessing or silently re-planning.`,
    `PI splits the task into subtasks — the tool only fans out execution.` +
      ` The launch response is { job_id, accepted, error? } and never includes synchronous result content.` +
      ` Final interpretation is PI's responsibility after [carrier:result] push; carrier_jobs is fallback/explicit lookup only.`,
    `Do not poll, wait-check, or call carrier_jobs merely to see whether the job is done.` +
      ` Continue independent work if available; otherwise stop tool use and wait passively for the [carrier:result] follow-up push.`,
    `Structure each carrier request using that carrier's required tags listed in <fleet section="roster">; missing required tags cause hard-error rejection by the dispatcher.`,
  ],
};

export const FLEET_SQUADRON_DESCRIPTION = deriveToolDescription(SQUADRON_MANIFEST);

// ─────────────────────────────────────────────────────────
// 2. Build 함수
// ─────────────────────────────────────────────────────────

/** carrier_squadron의 `promptSnippet` 값을 반환합니다. */
export function buildSquadronPromptSnippet(): string {
  return deriveToolPromptSnippet(SQUADRON_MANIFEST);
}

/**
 * carrier_squadron의 `promptGuidelines` 배열을 반환합니다.
 *
 * @param enabledCarrierIds squadron 활성 carrier ID 목록
 */
export function buildSquadronPromptGuidelines(enabledCarrierIds: string[]): string[] {
  if (enabledCarrierIds.length === 0) {
    return deriveToolPromptGuidelines(SQUADRON_MANIFEST, [
      `## Squadron Carriers\nNo carriers are currently enabled for Squadron.` +
      ` To enable, ${SQUADRON_CONFIGURE_HINT}.`,
    ]);
  }
  return deriveToolPromptGuidelines(SQUADRON_MANIFEST, []);
}

/**
 * carrier_squadron의 TypeBox `parameters` 스키마를 반환합니다.
 *
 * @param enabledCarrierIds squadron 활성 carrier ID 목록
 */
export function buildSquadronSchema(enabledCarrierIds: string[]): TObject {
  const availableDesc =
    enabledCarrierIds.length > 0
      ? `Squadron target carrier ID. Available: ${enabledCarrierIds.join(", ")}`
      : `Squadron target carrier ID. (No carriers currently enabled for Squadron — ${SQUADRON_CONFIGURE_HINT})`;

  return Type.Object({
    carrier: Type.String({ description: availableDesc }),
    expected_subtask_count: Type.Number({
      description: `Number of subtasks (must match subtasks array length). Max ${SQUADRON_MAX_INSTANCES}.`,
      minimum: 1,
      maximum: SQUADRON_MAX_INSTANCES,
    }),
    subtasks: Type.Array(
      Type.Object({
        title: Type.String({ description: "서브태스크 식별명" }),
        request: Type.String({ description: "개별 요청" }),
      }),
      { minItems: 1, maxItems: SQUADRON_MAX_INSTANCES },
    ),
  });
}
