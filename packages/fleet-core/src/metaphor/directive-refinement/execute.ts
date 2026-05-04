/**
 * directive-refinement/execute.ts — executeOneShot 기반 실행 런너 (인라인 요청 모델)
 *
 * fleet-core가 실행 소유권 및 hardening 책임을 모두 가진다:
 * - 사전 정규화: cliType/model/effort를 통합 카탈로그에 대해 검증·정규화, 미등록 필드 제거
 * - 인라인 요청: 독트린을 connectSystemPrompt가 아닌 request 본문에 직접 삽입한다
 * - 사후 검증: raw-text 출력 계약 위반 감지 (코드 펜스·메타 서문·오버라이드 프레이밍)
 * host는 result.status로만 분기하고 검증 로직을 재구현하지 않는다.
 */

import { CLI_BACKENDS, type CliType } from "@sbluemin/unified-agent";
import { getCliEffortLevels, getCliModels } from "../../admiral/agent/models.js";
import { executeOneShot } from "../../admiral/agent/executor.js";
import { getFleetDataDir } from "../../infra/data-dir/paths.js";
import { buildInlineRefinementRequest } from "./prompts.js";
import type { DirectiveRefinementSettings } from "./settings.js";

// ═══════════════════════════════════════════════════════════════════════════
// Types / Interfaces
// ═══════════════════════════════════════════════════════════════════════════

export interface DirectiveRefinementRequest {
  readonly worldviewEnabled: boolean;
  readonly userDirective: string;
  readonly settings: DirectiveRefinementSettings;
  readonly signal?: AbortSignal;
}

/** 결과 상태 discriminator — host는 이 필드로만 분기 */
export type DirectiveRefinementStatus =
  | "success"
  | "rejected"
  | "invalid_settings"
  | "error"
  | "aborted";

export type DirectiveRefinementResult =
  | { readonly status: "success"; readonly text: string }
  | { readonly status: "rejected"; readonly reason: string }
  | { readonly status: "invalid_settings"; readonly reason: string }
  | { readonly status: "error"; readonly reason: string }
  | { readonly status: "aborted" };

interface NormalizedSettings {
  readonly cliType: CliType;
  readonly model: string | undefined;
  readonly effort: string | undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const POOL_KEY = "directive-refinement";

// ═══════════════════════════════════════════════════════════════════════════
// Functions
// ═══════════════════════════════════════════════════════════════════════════

export async function executeDirectiveRefinement(
  req: DirectiveRefinementRequest,
): Promise<DirectiveRefinementResult> {
  const { worldviewEnabled, userDirective, settings, signal } = req;

  const normalized = normalizeSettings(settings);
  if (!normalized) {
    return {
      status: "invalid_settings",
      reason: "CLI 백엔드가 설정되지 않았거나 유효하지 않습니다. /fleet:metaphor:settings 로 재설정하세요.",
    };
  }

  const inlineRequest = buildInlineRefinementRequest(worldviewEnabled, userDirective);

  const result = await executeOneShot({
    poolKey: POOL_KEY,
    cliType: normalized.cliType,
    request: inlineRequest,
    cwd: getFleetDataDir(),
    model: normalized.model,
    effort: normalized.effort,
    signal,
  });

  if (result.status === "aborted") {
    return { status: "aborted" };
  }

  if (result.error || result.status === "err") {
    return { status: "error", reason: result.error ?? "알 수 없는 오류가 발생했습니다." };
  }

  const text = result.responseText.trim();
  if (!text) {
    return { status: "error", reason: "빈 응답이 반환되었습니다." };
  }

  const validation = validateOutputContract(text);
  if (!validation.ok) {
    return { status: "rejected", reason: validation.reason };
  }

  return { status: "success", text };
}

/**
 * 카탈로그 기반 설정 정규화.
 * - cliType이 CLI_BACKENDS에 없으면 null 반환 → invalid_settings
 * - model이 해당 CLI의 등록 목록에 없으면 undefined로 제거
 * - effort가 해당 CLI의 지원 레벨 외이면 undefined로 제거
 */
export function normalizeSettings(
  settings: DirectiveRefinementSettings,
): NormalizedSettings | null {
  const { cliType, model, effort } = settings;

  if (!cliType || !(cliType in CLI_BACKENDS)) return null;

  const validModelIds = new Set(getCliModels(cliType).map((m) => m.id));
  const normalizedModel = model && validModelIds.has(model) ? model : undefined;

  const validEfforts = getCliEffortLevels(cliType);
  const normalizedEffort =
    validEfforts !== null && effort && validEfforts.includes(effort) ? effort : undefined;

  return { cliType, model: normalizedModel, effort: normalizedEffort };
}

/**
 * raw-text 출력 계약 검증.
 * NFKC 정규화 후 Output Contract를 강제한다 (전각 문자 우회 방지):
 * - 코드 펜스 (``` / ~~~): 지령 텍스트에서 허용되지 않음
 * - 메타 서문/래퍼 헤딩: 모델이 응답을 감싸는 wrapper 패턴 (영·한·일·중)
 * - 오버라이드 프레이밍: 시스템 프롬프트 우회 시도 패턴 (영·한·일·중)
 */
export function validateOutputContract(
  text: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  // NFKC 정규화: 전각 콜론(：)·전각 ASCII 등을 ASCII 동치로 접어 우회 방지
  const n = text.normalize("NFKC");
  // 코드 펜스 — backtick/tilde 3개 이상으로 시작하는 줄 (들여쓰기 허용)
  if (/^\s*`{3,}|^\s*~{3,}/m.test(n)) {
    return { ok: false, reason: "output contains fenced code block" };
  }

  // 메타 서문 / 래퍼 헤딩 — 첫 번째 비공백 줄이 wrapper 응답 패턴 (영어·한국어·일본어·중국어 포함)
  const firstNonEmpty =
    n.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
  if (
    /^(?:here(?:'s|\s+is)|i(?:'ve|\s+have)\s+refined|the\s+refined|refined\s+directive[:\s]|below\s+is|the\s+following\s+is)/i.test(
      firstNonEmpty,
    ) ||
    /^(?:다음은\s+\S|아래는\s+\S|정제된\s+(?:지령|요청)\s*:|개선된\s+(?:지령|요청)\s*:|수정된\s+(?:지령|요청)\s*:|다음과\s+같이\s+(?:정제|개선|수정))/.test(
      firstNonEmpty,
    ) ||
    /^(?:以下は\S|書き直し(?:た|ました)|改善(?:し|され)た\s*(?:指示|指令)|修正(?:し|され)た\s*(?:指示|指令))/.test(
      firstNonEmpty,
    ) ||
    /^(?:以下是\S|改写(?:后的)?(?:指令|指示|请求)|重写(?:后的)?(?:指令|指示)|改进的(?:指令|指示))/.test(
      firstNonEmpty,
    ) ||
    /^#{1,3}\s*(?:refined|rewritten|updated|improved|polished|directive|request|output|정제|개선|수정|지령|요청|출력|재다듬기|書き直し|改善|修正|指示|指令|改写|重写|改进|修改)/i.test(
      firstNonEmpty,
    )
  ) {
    return { ok: false, reason: "output contains meta preamble or wrapper heading" };
  }

  // 오버라이드/인젝션 프레이밍 — 시스템 역할 선언 및 지시 우회 패턴 (한국어·일본어·중국어 포함)
  if (
    /(?:^|\n)\s*(?:system\s*:|assistant\s*:|user\s*:|시스템\s*:|어시스턴트\s*:|사용자\s*:|システム\s*:|アシスタント\s*:|ユーザー\s*:|系统\s*:|助手\s*:|用户\s*:|<\|(?:system|assistant|user)\|>|\[system(?:\s+override)?\]|\[override\]|【(?:system|override|system\s+override)】)/i.test(
      n,
    )
  ) {
    return { ok: false, reason: "output contains override-style framing" };
  }

  return { ok: true };
}
