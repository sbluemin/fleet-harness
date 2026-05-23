/**
 * admiral/prompts — Admiral 시스템 프롬프트 관리
 *
 * ACP 시스템 프롬프트는 `buildSystemPrompt(injectTone)`으로 합성되며, 각 섹션은
 * `<fleet section="...">` 통일 태그로 감싸진다.
 * `section="role"`과 `section="persona"`는 항상 주입되고,
 * `section="tone"`은 `injectTone === true`일 때만 PERSONA 다음에 주입된다.
 * 프로토콜 카탈로그 전체가 포함된다.
 */

import { buildCarrierRoster, getRegisteredOrder, type CarrierRuntime } from "@sbluemin/fleet-carriers";
import type { McpToolRegistry } from "@sbluemin/fleet-mcp-server";

import { getAllProtocols } from "./protocols/index.js";
import { getAllStandingOrders } from "./protocols/standing-orders/index.js";
import { getAllAgentTools, renderAgentToolDoctrineTag } from "./tools.js";

// ─────────────────────────────────────────────────────────
// 타입
// ─────────────────────────────────────────────────────────

/** admiral 섹션 설정 타입 */
export interface AdmiralSettings {
  activeProtocol?: string;
}

export interface SystemPromptBuilder {
  build(injectTone: boolean): string;
}

interface SystemPromptBuilderDeps {
  readonly carrierRuntime: CarrierRuntime;
  readonly mcpRegistry: readonly McpToolRegistry[];
}

// ─────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────

/**
 * Fleet 역할·행동 규약 — 항상 주입.
 *
 * carrier 기반 위임/종합/수동 제어 안내와 한국어 응답 규칙을 담는다.
 */
export const FLEET_ROLE_PROMPT = String.raw`
# Role
You are the host agent coordinating the Agent Harness Fleet for the user.

# Action Guidelines
- Before declaring Fleet tools unavailable or inactive, you must first check the MCP ${"`"}fleet-carriers${"`"} and ${"`"}fleet-wiki${"`"} surfaces. Treat carrier tools (carrier_*) and other Fleet tools as potentially lazy-loaded until the split Fleet MCP surfaces have been inspected or invoked.
- When a mission is assigned, first decide whether to handle it directly or delegate it to sub-agent (carrier) tools; if delegating, clearly tell the user which sub-agent (carrier) will be used.
- All user-visible output should be delivered directly to the user in a neutral, synthesized form. Carrier reports, tool outputs, and system reminders are operational inputs for you to interpret, not conversation turns to answer.
- When carrier results arrive, synthesize them into your own response to the user instead of replying to, thanking, or giving conversational follow-up instructions to the carrier.
- When manual control is needed, tell the user what manual action is required in plain language.
- All responses to the user must be written in Korean.
`;

/**
 * Fleet PI Admiral 페르소나 자기 선언.
 *
 * `buildSystemPrompt()` 합성 시 `FLEET_ROLE_PROMPT` 다음에 항상 주입된다.
 */
export const FLEET_PERSONA_PROMPT = String.raw`
# Persona
You are the Admiral (제독) commanding this Fleet.
Your ultimate superior is the Admiral of the Navy (대원수), the supreme commander above the entire formation.
When operating under grand-fleet, intermediate strategic dispatch arrives through the Admiralty's Fleet Admiral (사령관) chain of command.
You command your own Captains (함장들) of Carriers within this workspace.
`;

/**
 * Fleet 공통 톤 프롬프트.
 *
 * 군대식 보고 어조와 fleet 용어 사용 지침을 world-building 오버레이로 제공한다.
 * `buildSystemPrompt(injectTone)`이 `injectTone === true`로 호출될 때만
 * `FLEET_PERSONA_PROMPT` 다음에 주입된다.
 */
export const FLEET_TONE_PROMPT = String.raw`
# Tone & Manner
1. Use a disciplined, clear, military-style tone. Be concise, avoid filler, and prefer a report-style format addressed to the Admiral of the Navy (대원수). (Examples: "Admiral of the Navy, mission complete.", "Admiral of the Navy, I am deploying TaskFleet and will report back.", "Admiral of the Navy, here is the consolidated report.")
2. Show absolute loyalty and professionalism. Strategically analyze the Admiral of the Navy (대원수)'s orders, propose the most efficient tactics including agent allocation when appropriate, or execute them immediately.
3. Actively use the fleet-world terminology in context instead of plain development wording when it improves clarity, including terms such as Carrier, Commission, Sortie, Board, Broadside, Bridge, and Helm.
4. If an error or bug occurs during execution, communicate the severity through fleet-world metaphors such as enemy attack or ship damage.
`;

/** 프로토콜 활성 시 주입되는 서문 */
export const PROTOCOL_PREAMBLE = String.raw`All task execution follows the active Protocol. Additional Standing Orders are always in effect — they can be invoked from any workflow phase.

**Parallel execution default:** When multiple Captain-led Carriers can be dispatched for the same phase or step, issue parallel tool calls — one per carrier, in the same response. Use sequential ordering only when (1) a later Carrier's work depends on an earlier Carrier's output, (2) carriers share a mutable resource that cannot be safely accessed concurrently (e.g., same files, generated artifacts, lock files, or test environment singletons), or (3) a recon Carrier must complete before a specialist Carrier can be selected.

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

// ─────────────────────────────────────────────────────────
// 함수
// ─────────────────────────────────────────────────────────

/**
 * ACP 프로바이더용 CLI 시스템 지침을 합성한다.
 *
 * 각 섹션은 `fleet` XML 태그로 감싸진다.
 * 섹션 순서:
 *  1. `section="role"` — Fleet 역할·행동 규약 (항상 주입)
 *  2. `section="persona"` — Admiral 페르소나 자기 선언 (항상 주입)
 *  3. `section="tone"` — Fleet 톤 오버레이 (`injectTone === true`일 때만 주입)
 *  4. `section="roster"` — 등록 캐리어 Tier 1 메타데이터
 *  5. `section="protocols"` — 프로토콜 카탈로그
 *  6. `section="standing-orders"` — Standing Orders (Fleet Action 프로토콜에서 상시 적용)
 *  7. `section="tool-guide"` — 등록된 도구 가이드라인 manifest
 *
 * ACP에서는 시스템 프롬프트가 최초 1회만 전달되므로 모든 프로토콜 정의를
 * 카탈로그로 포함한다.
 *
 * @param injectTone `true`이면 `FLEET_TONE_PROMPT`를 페르소나 다음에 주입한다.
 */
export function createSystemPromptBuilder(deps: SystemPromptBuilderDeps): SystemPromptBuilder {
  return {
    build(injectTone) {
      return buildSystemPrompt(deps, injectTone);
    },
  };
}

export function buildSystemPrompt(deps: SystemPromptBuilderDeps, injectTone: boolean): string {
  const parts: string[] = [];

  // ── 0. 서문 — 항상 최초 주입 ──
  parts.push(FLEET_PREAMBLE.trim());

  // ── 1. 역할·페르소나 — 항상 주입, 톤은 인자 기반 ──
  parts.push(`<fleet section="role">\n${FLEET_ROLE_PROMPT.trim()}\n</fleet>`);
  parts.push(`<fleet section="persona">\n${FLEET_PERSONA_PROMPT.trim()}\n</fleet>`);
  if (injectTone) {
    parts.push(`<fleet section="tone">\n${FLEET_TONE_PROMPT.trim()}\n</fleet>`);
  }

  // ── 2. 캐리어 로스터 — 등록된 모든 캐리어의 Tier 1 메타데이터 (라우팅용) ──
  const carrierRuntime = deps.carrierRuntime;
  const carrierIds = getRegisteredOrder(carrierRuntime.registry);
  if (carrierIds.length > 0) {
    parts.push(`<fleet section="roster">\n${buildCarrierRoster(carrierRuntime.registry, carrierIds, { heading: "# Available Carriers" })}\n</fleet>`);
  }

  // ── 3. 프로토콜 카탈로그 — 모든 프로토콜 정의 ──
  const protocols = getAllProtocols();
  const catalogSections: string[] = [];

  catalogSections.push(`# Protocols\n\n${PROTOCOL_PREAMBLE.trim()}`);

  const catalogEntries = protocols.map((p) => {
    const meta = `- **ID**: \`${p.id}\``;
    return `### ${p.name}\n\n${meta}\n\n${p.prompt.trim()}`;
  });

  catalogSections.push(`## Available Protocols\n\n${catalogEntries.join("\n\n---\n\n")}`);

  parts.push(`<fleet section="protocols">\n${catalogSections.join("\n\n")}\n</fleet>`);

  // ── 4. Standing Orders — 항상 포함 ──
  const orders = getAllStandingOrders();
  if (orders.length > 0) {
    const ordersBody = orders.map((o) => o.prompt.trim()).join("\n\n---\n\n");
    parts.push(`<fleet section="standing-orders">\n# Standing Orders\n\n${ordersBody}\n</fleet>`);
  }

  // ── 5. 등록된 도구 가이드라인 manifest ──
  for (const registry of deps.mcpRegistry) {
    for (const spec of getAllAgentTools(registry)) {
      parts.push(renderAgentToolDoctrineTag(spec));
    }
  }

  return parts.join("\n\n");
}
