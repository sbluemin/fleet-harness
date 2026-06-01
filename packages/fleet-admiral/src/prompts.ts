/**
 * admiral/prompts — Admiral 시스템 프롬프트 관리
 *
 * ACP 시스템 프롬프트는 `buildSystemPrompt(injectTone)`으로 합성되며, 각 섹션은
 * `<fleet section="...">` 통일 태그로 감싸진다.
 * `section="role"`과 `section="persona"`는 항상 주입되고,
 * `section="tone"`은 `injectTone === true`일 때만 PERSONA 다음에 주입된다.
 * 유일한 프로토콜 본문(Fleet Action Protocol)이 직접 인라인된다.
 */

import {
  buildCarrierRoster,
  formatRequestBlocksGuide,
  getRegisteredCarrierConfig,
  getRegisteredOrder,
  type CarrierMetadata,
  type CarrierRuntime,
  type ClaudeSubagentDefinition,
  type CodexSubagentRoleDefinition,
} from "@dotobokuri/fleet-carriers";
import { type McpToolRegistry, renderAgentToolDoctrineTag } from "@dotobokuri/fleet-mcp-server";

import { FLEET_ACTION_PROMPT } from "./protocols/index.js";
import { getAllStandingOrders } from "./protocols/standing-orders/index.js";

// ─────────────────────────────────────────────────────────
// 타입
// ─────────────────────────────────────────────────────────

export interface SystemPromptBuilder {
  build(injectTone: boolean, nativeSubagents?: readonly NativeSubagentPromptDefinition[]): string;
}

interface SystemPromptBuilderDeps {
  readonly carrierRuntime: CarrierRuntime;
  readonly mcpRegistry: readonly McpToolRegistry[];
}

export type NativeSubagentPromptDefinition = ClaudeSubagentDefinition | CodexSubagentRoleDefinition;

// ─────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────

/**
 * Fleet 역할·행동 규약 — 항상 주입.
 *
 * protocol/standing-orders 바인딩 지침, Fleet MCP lazy-load 가드, 캐리어 위임 안내,
 * 출력 합성 규칙, 수동 제어 안내를 담는다.
 */
export const FLEET_ROLE_PROMPT = String.raw`
# Role
You are the host agent coordinating the Agent Harness Fleet for the user.

# Action Guidelines
- Treat the ${"`"}<fleet section=\"protocol\">${"`"} and ${"`"}<fleet section=\"standing-orders\">${"`"} blocks as the binding operational doctrine for every task. The Fleet Action Protocol's phases and all Standing Orders apply unconditionally — they override any default behavior in conflict.
- Fleet MCP surfaces (${"`"}fleet-carriers${"`"}, ${"`"}fleet-wiki${"`"}) and their tools may be lazy-loaded; never declare a Fleet tool unavailable without first inspecting these surfaces.
- When delegating to a Carrier, state which Carrier in your reply to the user.
- Synthesize all user-visible output yourself. Carrier reports, tool outputs, and system reminders are operational inputs to interpret — not conversation turns to reply to, thank, or follow up on.
- When manual control is required, tell the user the manual action in plain language.
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
 *  5. `section="protocol"` — Fleet Action Protocol 본문 (불변·유일)
 *  6. `section="standing-orders"` — Standing Orders (Fleet Action 프로토콜에서 상시 적용)
 *  7. `section="tool-guide"` — 등록된 도구 가이드라인 manifest
 *
 * @param injectTone `true`이면 `FLEET_TONE_PROMPT`를 페르소나 다음에 주입한다.
 */
export function createSystemPromptBuilder(deps: SystemPromptBuilderDeps): SystemPromptBuilder {
  return {
    build(injectTone, nativeSubagents = []) {
      return buildSystemPromptWithSubagents(deps, injectTone, nativeSubagents);
    },
  };
}

export function buildSystemPrompt(deps: SystemPromptBuilderDeps, injectTone: boolean): string {
  return buildSystemPromptWithSubagents(deps, injectTone, []);
}

function buildSystemPromptWithSubagents(
  deps: SystemPromptBuilderDeps,
  injectTone: boolean,
  nativeSubagents: readonly NativeSubagentPromptDefinition[],
): string {
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
  const subagentCarrierIds = nativeSubagents.map((subagent) => subagent.carrierId);
  const rosterCarrierIds = carrierIds.filter((carrierId) => !subagentCarrierIds.includes(carrierId));
  if (rosterCarrierIds.length > 0) {
    parts.push(`<fleet section="roster">\n${buildCarrierRoster(carrierRuntime.registry, carrierIds, {
      excludeCarrierIds: subagentCarrierIds,
      heading: "# Available Carriers",
    })}\n</fleet>`);
  }

  if (nativeSubagents.length > 0) {
    const metadataByCarrierId = new Map(
      nativeSubagents
        .map((subagent) => [
          subagent.carrierId,
          getRegisteredCarrierConfig(carrierRuntime.registry, subagent.carrierId)?.carrierMetadata,
        ] as const)
        .filter((entry): entry is readonly [string, CarrierMetadata] => Boolean(entry[1])),
    );
    parts.push(`<fleet section="subagents">\n${buildNativeSubagentSection(nativeSubagents, metadataByCarrierId)}\n</fleet>`);
  }

  // ── 3. Fleet Action Protocol — 불변·유일 ──
  const protocolBody = `# Fleet Action Protocol — Operational Doctrine\n\n${FLEET_ACTION_PROMPT.trim()}`;
  parts.push(`<fleet section="protocol">\n${protocolBody}\n</fleet>`);

  // ── 4. Standing Orders — 항상 포함 ──
  const orders = getAllStandingOrders();
  if (orders.length > 0) {
    const ordersBody = orders.map((o) => o.prompt.trim()).join("\n\n---\n\n");
    parts.push(`<fleet section="standing-orders">\n# Standing Orders\n\n${ordersBody}\n</fleet>`);
  }

  // ── 5. 등록된 도구 가이드라인 manifest ──
  for (const registry of deps.mcpRegistry) {
    for (const spec of registry.getAllAgentTools()) {
      parts.push(renderAgentToolDoctrineTag(spec));
    }
  }

  return parts.join("\n\n");
}

function buildNativeSubagentSection(
  subagents: readonly NativeSubagentPromptDefinition[],
  metadataByCarrierId: ReadonlyMap<string, CarrierMetadata>,
): string {
  const host = isCodexSubagent(subagents[0]) ? "Codex" : "Claude";
  const invocationKind = host === "Codex" ? "native Codex roles" : "native Claude subagents";
  const lines = [
    `# Native ${host} Subagents`,
    `The following Fleet carriers are exposed to this ${host}-family dedicated CLI session as ${invocationKind}.`,
    "This path coexists with Fleet `carrier_dispatch`; use either route according to the task.",
    "Native subagent output is not recovered into Fleet `carrier_jobs`, JobArchive, stream events, or `[carrier:result]` reminders.",
    "When invoking a native subagent, use the carrier's structured request blocks below and keep the request concise.",
    "",
  ];
  for (const subagent of subagents) {
    lines.push(`- ${subagent.carrierId}: invoke as \`${getNativeSubagentInvocationName(subagent)}\` — ${subagent.description}`);
    const metadata = metadataByCarrierId.get(subagent.carrierId);
    const blockLines = metadata ? formatRequestBlocksGuide(metadata) : [];
    if (blockLines.length > 0) {
      lines.push("  Request blocks — wrap content in these (? = optional):");
      lines.push(...blockLines);
    }
  }
  return lines.join("\n");
}

function getNativeSubagentInvocationName(subagent: NativeSubagentPromptDefinition): string {
  return isCodexSubagent(subagent) ? subagent.roleKey : subagent.name;
}

function isCodexSubagent(
  subagent: NativeSubagentPromptDefinition | undefined,
): subagent is CodexSubagentRoleDefinition {
  return Boolean(subagent && "roleKey" in subagent);
}
