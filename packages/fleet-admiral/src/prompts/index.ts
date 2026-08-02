/**
 * admiral/prompts — Admiral 시스템 프롬프트 관리
 *
 * ACP 시스템 프롬프트는 `createSystemPromptBuilder(deps).build(...)`로 합성되며, 각 섹션은
 * `<fleet section="...">` 통일 태그로 감싸진다.
 *
 * doctrine(classic|gateway) 축은 프롬프트 본문을 통째로 가른다. 두 경로는 섹션 구성과
 * 본문을 공유하지 않고 각각 `./classic.ts`와 `./gateway.ts`가 단독으로 소유한다.
 * metaphor 축은 classic 경로에서만 persona/tone 오버레이를 제어한다. gateway 경로는
 * 메타포 오버레이를 렌더하지 않으므로 `enableMetaphor`가 결과에 영향을 주지 않는다.
 */

import { type CarrierRuntime } from "@dotobokuri/fleet-carriers";

import { type AdmiralDoctrine } from "../protocols/doctrine.js";
import { buildClassicSystemPrompt } from "./classic.js";
import { buildGatewaySystemPrompt } from "./gateway.js";

// ─────────────────────────────────────────────────────────
// 타입
// ─────────────────────────────────────────────────────────

export interface SystemPromptBuildOptions {
  readonly enableMetaphor: boolean;
  readonly doctrine?: AdmiralDoctrine;
}

export interface SystemPromptBuilder {
  build(input: boolean | SystemPromptBuildOptions): string;
}

interface SystemPromptBuilderDeps {
  readonly carrierRuntime: CarrierRuntime;
}

// ─────────────────────────────────────────────────────────
// 함수
// ─────────────────────────────────────────────────────────

/**
 * ACP 프로바이더용 CLI 시스템 지침을 합성한다.
 *
 * `build(enableMetaphor)`는 doctrine=`classic`으로 유지되는 하위호환 오버로드다.
 */
export function createSystemPromptBuilder(deps: SystemPromptBuilderDeps): SystemPromptBuilder {
  return {
    build(input: boolean | SystemPromptBuildOptions) {
      const { enableMetaphor, doctrine } = normalizeBuildOptions(input);
      return doctrine === "gateway"
        ? buildGatewaySystemPrompt()
        : buildClassicSystemPrompt(deps.carrierRuntime, enableMetaphor);
    },
  };
}

function normalizeBuildOptions(input: boolean | SystemPromptBuildOptions): Required<SystemPromptBuildOptions> {
  if (typeof input === "boolean") {
    return { enableMetaphor: input, doctrine: "classic" };
  }
  return {
    enableMetaphor: input.enableMetaphor,
    doctrine: input.doctrine ?? "classic",
  };
}
