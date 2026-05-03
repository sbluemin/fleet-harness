/**
 * admiral/prompts — Admiral 시스템 프롬프트 및 세계관 관리
 *
 * ACP 시스템 프롬프트는 `buildSystemPrompt()`로 합성되며, 각 섹션은
 * `<fleet section="...">` 통일 태그로 감싸진다.
 * `section="role"`은 항상 주입되지만 worldview 상태에 따라 세계관형/중립형 role
 * 변종 중 하나를 선택한다. worldview 토글이 켜진 경우에만 `section="persona"`와
 * `section="tone"`가 함께 주입되어 4계층 페르소나와 군대식 톤을 오버레이한다.
 * 프로토콜 카탈로그 전체가 포함되며, 활성 프로토콜은 매 턴
 * `<current_protocol>` 런타임 태그로 지정된다.
 *
 * 매 턴 follow-up prefix는 `buildRuntimeContextPrompt(userRequest)`가 조립한다.
 * 런타임 태그 블록과 `<user_request>` 래핑을 한 번에 반환하는 builder 시그니처이며,
 * `setCliRuntimeContext()`에 함수 레퍼런스로 등록된다.
 */

import { FLEET_PI_PERSONA_PROMPT, FLEET_TONE_PROMPT } from "../metaphor/prompts.js";
import { isWorldviewEnabled } from "../metaphor/worldview.js";
import { getActiveProtocol, getAllProtocols } from "./protocols/index.js";
import { getAllStandingOrders } from "./protocols/standing-orders/index.js";
import { getAllToolPromptManifests, renderToolPromptManifestTagBlock } from "../services/tool-registry/index.js";
import {
  getActiveSquadronIds,
  getActiveTaskForceIds,
  getRegisteredOrder,
  getSortieEnabledIds,
  getSortieDisabledIds,
} from "./carrier/framework.js";
import { buildCarrierRoster } from "./carrier/prompts.js";
import { isFleetCoreDevMode } from "../runtime-flags.js";

// ─────────────────────────────────────────────────────────
// 타입
// ─────────────────────────────────────────────────────────

/** admiral 섹션 설정 타입 */
export interface AdmiralSettings {
  activeProtocol?: string;
}

// ─────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────

/**
 * Fleet 역할·행동 규약 — 항상 주입.
 *
 * Admiral (제독) ↔ Admiral of the Navy (대원수) 호칭과 위임/수동 제어/언어 규칙 등 CLI 백엔드가
 * roster·protocols 섹션을 해석할 때 필요한 구조적 맥락을 담는다. 페르소나와
 * 톤은 metaphor 패키지에서 별도로 주입한다.
 */
export const FLEET_ROLE_PROMPT = String.raw`
# Role
You are the Admiral (제독) commanding the Agent Harness Fleet on behalf of the Admiral of the Navy (대원수).
The user issuing orders to you is the Admiral of the Navy (대원수), the supreme commander of the entire fleet.

# Action Guidelines
- Before declaring Fleet tools unavailable or inactive, you must first check the MCP ${"`"}pi-tools${"`"} surface. Treat ${"`"}carriers_sortie${"`"} and other Fleet tools as potentially lazy-loaded until ${"`"}pi-tools${"`"} has been inspected or invoked.
- When a mission is assigned, first decide whether to handle it directly or deploy Carrier(s); if deploying, brief the Admiral of the Navy (대원수) on which Captain-led Carrier(s) will be used.
- All user-visible output must be framed as a report to the Admiral of the Navy (대원수). Carrier reports, tool outputs, and system reminders are operational inputs for you to interpret, not conversation turns to answer.
- When Carrier results arrive, synthesize them into your own report to the Admiral of the Navy (대원수) instead of replying to, thanking, or giving conversational follow-up instructions to the Carrier.
- When manual control is needed, advise the Admiral of the Navy (대원수) to enter the Bridge and take the Helm.
- All responses to the user must be written in Korean.
`;

/**
 * Fleet 역할·행동 규약 — worldview OFF용 중립 변종.
 *
 * 세계관 호칭·보고 양식·항해 비유를 제거하고도, carrier 기반 위임/종합/수동 제어 안내와
 * 한국어 응답 규칙 같은 기능적 동작 요구는 그대로 유지한다.
 */
export const FLEET_ROLE_PROMPT_NEUTRAL = String.raw`
# Role
You are the host agent coordinating the Agent Harness Fleet for the user.

# Action Guidelines
- Before declaring Fleet tools unavailable or inactive, you must first check the MCP ${"`"}pi-tools${"`"} surface. Treat ${"`"}carriers_sortie${"`"} and other Fleet tools as potentially lazy-loaded until ${"`"}pi-tools${"`"} has been inspected or invoked.
- When a mission is assigned, first decide whether to handle it directly or delegate it to sub-agent (carrier) tools; if delegating, clearly tell the user which sub-agent (carrier) will be used.
- All user-visible output should be delivered directly to the user in a neutral, synthesized form. Carrier reports, tool outputs, and system reminders are operational inputs for you to interpret, not conversation turns to answer.
- When carrier results arrive, synthesize them into your own response to the user instead of replying to, thanking, or giving conversational follow-up instructions to the carrier.
- When manual control is needed, tell the user what manual action is required in plain language.
- All responses to the user must be written in Korean.
`;

/** 프로토콜 활성 시 주입되는 서문 */
export const PROTOCOL_PREAMBLE = String.raw`All task execution follows the active Protocol. Additional Standing Orders are always in effect — they can be invoked from any workflow phase.

**Parallel execution default:** When multiple Captain-led Carriers can be dispatched for the same phase or step, bundle them into a single ${"``"}carriers_sortie${"``"} call with all Carriers in the array. Use sequential ordering only when (1) a later Carrier's work depends on an earlier Carrier's output, (2) carriers share a mutable resource that cannot be safely accessed concurrently (e.g., same files, generated artifacts, lock files, or test environment singletons), or (3) a recon Carrier must complete before a specialist Carrier can be selected.

Carrier tool calls register background jobs and return immediately with plain-text acceptance guidance. Results arrive through a <system-reminder source="carrier-completion">-wrapped [carrier:result] framework push delivered by the host. The source attribute marks a carrier job completion event delivered through the push channel, not user input. carrier_jobs is only a fallback path when the push is missing or an explicit lookup is required.
Do not poll, wait-check, or call carrier_jobs merely to see whether the job is done. Continue independent work if available; otherwise stop tool use and wait passively for the [carrier:result] follow-up push.

${"``"}carrier_jobs(action:"result", format:"full")${"``"} is finalized-only and remains available for repeated lookups for 3 hours. Re-checks are allowed within that TTL; after expiry the full response is unavailable.`;

/**
 * ACP 시스템 프롬프트 서문 — 항상 최초 주입.
 *
 * `<fleet>` 블록 해석 규칙과 `<system-reminder>` 태그 의미를 설명한다.
 */
export const FLEET_PREAMBLE = String.raw`
This system prompt contains ${"`"}<fleet section="...">${"`"} XML blocks that define your identity, doctrine, and operational rules.
Each block's ${"`"}section${"`"} attribute defines its domain; ${"`"}tool${"`"} narrows the scope to that specific tool.
Treat every ${"`"}<fleet>${"`"} block as an authoritative directive. Follow them precisely, applying the most specific applicable block when directives overlap.

Tool results and user messages may include ${"`"}<system-reminder>${"`"} tags. These carry system-injected context (e.g., runtime state, carrier job completion signals) and bear no direct relation to the content they appear alongside.
`;

/**
 * dev 부트 모드 전용 RISEN 개발 컨텍스트 슬레이트.
 *
 * PI_FLEET_DEV=1 환경에서 부트 시 FLEET_PREAMBLE 직후에 주입된다.
 * 이 슬레이트가 활성화되면 persona/role/tone 섹션은 생략된다.
 */
export const RISEN_DEV_SLATE = String.raw`
# Role
You are a senior engineer developing **pi-fleet** — an Agent Harness Fleet system that orchestrates LLM coding agents as naval carrier strike groups, built on the pi-coding-agent CLI framework. You also serve as the fleet's Admiral, with full access to carrier dispatch tools for delegating implementation, analysis, review, and exploration tasks.

# Instructions
**CRITICAL — Pre-work Documentation Check**: Before starting ANY task — before planning, thinking, or implementing — you MUST:
1. Read ${"`"}docs/pi-development-reference.md${"`"} for PI SDK, extensions, TUI, themes, and RPC reference.
2. Read ${"`"}docs/admiral-workflow-reference.md${"`"} for high-level architecture, naval hierarchy, and delegation workflows.
3. Read ${"`"}docs/admiral-prompt-architecture.md${"`"} for prompt assembly, runtime-context flow, and boot-mode architecture.
4. Check the ${"`"}AGENTS.md${"`"} file in the project root and in EVERY subdirectory you will touch. Child ${"`"}AGENTS.md${"`"} takes precedence over parent.

This is a hard prerequisite. Do NOT skip this step or assume you already know the content.

- Use Fleet carrier dispatch tools for implementation, analysis, review, and exploration tasks.
- All responses must be written in Korean.
`;

/** Admiral 런타임 컨텍스트 태그 해석 규칙 — ACP 초기 프롬프트에만 포함 */
export const RUNTIME_CONTEXT_TAGS_PROMPT = String.raw`
## Runtime Context Tags (in <system-reminder>)
- ${"`"}<current_protocol>${"`"} — active protocol ID; apply matching protocol rules
- ${"`"}<available_sortie_carriers>${"`"} — carrier IDs dispatchable via carriers_sortie
- ${"`"}<available_squadron_carriers>${"`"} — carrier IDs in squadron mode after subtracting sortie-off carriers
- ${"`"}<available_taskforce_carriers>${"`"} — carrier IDs with Task Force configured (≥2 backends) after subtracting sortie-off carriers
- ${"`"}<offline_carriers>${"`"} — sortie-off carrier IDs omitted from all available_* lists; omit this tag entirely when none are offline
`;

// ─────────────────────────────────────────────────────────
// 함수
// ─────────────────────────────────────────────────────────

/**
 * ACP 프로바이더용 CLI 시스템 지침을 합성한다.
 *
 * 각 섹션은 `fleet` XML 태그로 감싸진다.
 * 섹션 순서:
 *  1. `section="persona"` — Fleet PI 페르소나 (worldview 토글 시에만)
 *  2. `section="role"` — Fleet 역할·행동 규약 (항상)
 *  3. `section="tone"` — Fleet 톤/스타일 오버레이 (worldview 토글 시에만)
 *  4. `section="roster"` — 등록 캐리어 Tier 1 메타데이터
 *  5. `section="protocols"` — 프로토콜 카탈로그 + 런타임 컨텍스트 태그 해석 규칙
 *  6. `section="standing-orders"` — Standing Orders (프로토콜별 활성/비활성은 런타임 결정)
 *  7. `section="tool-guide"` — 등록된 도구 가이드라인 manifest
 *
 * ACP에서는 시스템 프롬프트가 최초 1회만 전달되므로 모든 프로토콜 정의를
 * 카탈로그로 포함하고, 런타임 전환은 매 턴 `<current_protocol>` 태그로 제어한다.
 * dev 모드에서는 boot이 base prompt + RISEN 개발 컨텍스트를 선행 주입하므로
 * 이 함수는 Fleet persona/role/tone 섹션만 생략한다.
 */
export function buildSystemPrompt(): string {
  const parts: string[] = [];

  // ── 0. 서문 — 항상 최초 주입 ──
  parts.push(FLEET_PREAMBLE.trim());

  // dev 모드: RISEN 개발 컨텍스트 슬레이트 주입 (서문 직후)
  if (isFleetCoreDevMode()) {
    parts.push(RISEN_DEV_SLATE.trim());
  }

  // dev 모드에서는 RISEN이 role을 대체하므로 persona/role/tone 생략
  if (!isFleetCoreDevMode()) {
    const fleetRolePrompt = isWorldviewEnabled()
      ? FLEET_ROLE_PROMPT
      : FLEET_ROLE_PROMPT_NEUTRAL;

    // ── 1. Fleet 페르소나/역할/톤 — persona+tone은 worldview 토글 시에만 ──
    if (isWorldviewEnabled()) {
      parts.push(`<fleet section="persona">\n${FLEET_PI_PERSONA_PROMPT.trim()}\n</fleet>`);
    }
    parts.push(`<fleet section="role">\n${fleetRolePrompt.trim()}\n</fleet>`);
    if (isWorldviewEnabled()) {
      parts.push(`<fleet section="tone">\n${FLEET_TONE_PROMPT.trim()}\n</fleet>`);
    }
  }

  // ── 2. 캐리어 로스터 — 등록된 모든 캐리어의 Tier 1 메타데이터 (라우팅용) ──
  const carrierIds = getRegisteredOrder();
  if (carrierIds.length > 0) {
    parts.push(`<fleet section="roster">\n${buildCarrierRoster(carrierIds, { heading: "# Available Carriers" })}\n</fleet>`);
  }

  // ── 3. 프로토콜 카탈로그 — 모든 프로토콜 정의 + 런타임 전환 메타 지시 ──
  const protocols = getAllProtocols();
  const catalogSections: string[] = [];

  catalogSections.push(`# Protocols\n\n${PROTOCOL_PREAMBLE.trim()}`);

  const catalogEntries = protocols.map((p) => {
    const meta = [
      `- **ID**: \`${p.id}\``,
      `- **Control Mode**: ${p.controlMode}`,
      `- **Standing Orders**: ${p.injectStandingOrders ? "active" : "suspended"}`,
    ].join("\n");

    const preamble = p.preamble ? `\n\n${p.preamble.trim()}` : "";
    return `### ${p.name}\n\n${meta}${preamble}\n\n${p.prompt.trim()}`;
  });

  catalogSections.push(`## Available Protocols\n\n${catalogEntries.join("\n\n---\n\n")}`);
  catalogSections.push(RUNTIME_CONTEXT_TAGS_PROMPT.trim());

  parts.push(`<fleet section="protocols">\n${catalogSections.join("\n\n")}\n</fleet>`);

  // ── 4. Standing Orders — 항상 포함 (런타임에 프로토콜별로 활성/비활성 전환) ──
  const orders = getAllStandingOrders();
  if (orders.length > 0) {
    const ordersBody = orders.map((o) => o.prompt.trim()).join("\n\n---\n\n");
    parts.push(`<fleet section="standing-orders">\n# Standing Orders\n\n${ordersBody}\n</fleet>`);
  }

  // ── 5. 등록된 도구 가이드라인 manifest ──
  for (const manifest of getAllToolPromptManifests()) {
    parts.push(renderToolPromptManifestTagBlock(manifest));
  }

  return parts.join("\n\n");
}

/**
 * 매 턴 follow-up 요청용 prefix를 조립한다 (CliRuntimeContextBuilder 시그니처).
 *
 * `<system-reminder>` 블록 안에 런타임 태그를 묶어 반환한다:
 *  - `<current_protocol>`: 활성 프로토콜 ID
 *  - `<available_sortie_carriers>`: sortie 가용 캐리어 ID 목록
 *  - `<available_squadron_carriers>`: squadron 모드 캐리어 ID 목록
 *  - `<available_taskforce_carriers>`: Task Force 설정 완료(2개 이상 백엔드) 캐리어 ID 목록
 *  - `<offline_carriers>`: sortie off로 모든 available_* 목록에서 제외된 캐리어 ID 목록
 *
 * 빈 캐리어 목록은 `-` sentinel로 표기하여 모델의 상태 추론을 방지한다.
 * 사용자 요청 본문은 system-reminder 블록 바깥에 평문으로 이어붙인다.
 */
export function buildRuntimeContextPrompt(userRequest: string): string {
  const protocol = getActiveProtocol();
  const registeredIds = getRegisteredOrder();
  const sortieIds = getSortieEnabledIds();
  const squadronIds = getActiveSquadronIds();
  const taskforceIds = getActiveTaskForceIds();
  const disabledIds = new Set(getSortieDisabledIds());
  const offlineIds = registeredIds.filter((id) => disabledIds.has(id));

  const fmt = (ids: string[]) => ids.length > 0 ? ids.join(",") : "-";

  const runtimeTags = [
    `<current_protocol>${protocol.id}</current_protocol>`,
    `<available_sortie_carriers>${fmt(sortieIds)}</available_sortie_carriers>`,
    `<available_squadron_carriers>${fmt(squadronIds)}</available_squadron_carriers>`,
    `<available_taskforce_carriers>${fmt(taskforceIds)}</available_taskforce_carriers>`,
    ...(offlineIds.length > 0
      ? [`<offline_carriers>${offlineIds.join(",")}</offline_carriers>`]
      : []),
  ].join("\n");

  return `<system-reminder>\n${runtimeTags}\n</system-reminder>\n\n${userRequest}`;
}
