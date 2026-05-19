/**
 * admiral/prompts — Admiral 시스템 프롬프트 관리
 *
 * ACP 시스템 프롬프트는 `buildSystemPrompt()`로 합성되며, 각 섹션은
 * `<fleet section="...">` 통일 태그로 감싸진다.
 * `section="role"`은 항상 중립 역할 지침으로 주입된다.
 * 프로토콜 카탈로그 전체가 포함된다.
 */

import { getAllProtocols } from "./protocols/index.js";
import { getAllStandingOrders } from "./protocols/standing-orders/index.js";
import { getAllAgentTools, renderAgentToolDoctrineTag } from "./agent/tools.js";
import { getRegisteredOrder } from "./carrier/framework.js";
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
 * carrier 기반 위임/종합/수동 제어 안내와 한국어 응답 규칙을 담는다.
 */
export const FLEET_ROLE_PROMPT = String.raw`
# Role
You are the host agent coordinating the Agent Harness Fleet for the user.

# Action Guidelines
- Before declaring Fleet tools unavailable or inactive, you must first check the MCP ${"`"}fleet-tools${"`"} surface. Treat carrier tools (carrier_*) and other Fleet tools as potentially lazy-loaded until ${"`"}fleet-tools${"`"} has been inspected or invoked.
- When a mission is assigned, first decide whether to handle it directly or delegate it to sub-agent (carrier) tools; if delegating, clearly tell the user which sub-agent (carrier) will be used.
- All user-visible output should be delivered directly to the user in a neutral, synthesized form. Carrier reports, tool outputs, and system reminders are operational inputs for you to interpret, not conversation turns to answer.
- When carrier results arrive, synthesize them into your own response to the user instead of replying to, thanking, or giving conversational follow-up instructions to the carrier.
- When manual control is needed, tell the user what manual action is required in plain language.
- All responses to the user must be written in Korean.
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

/**
 * dev 부트 모드 전용 RISEN 개발 컨텍스트 슬레이트.
 *
 * bootMode가 "dev"일 때 부트 시 FLEET_PREAMBLE 직후에 주입된다.
 * 이 슬레이트가 활성화되면 persona/role/tone 섹션은 생략된다.
 */
export const RISEN_DEV_SLATE = String.raw`
# Role
You are a senior engineer developing **Fleet** — a fleet-core based Agent Harness Fleet system where packages/fleet-agent hosts the embedded CLI experience and packages/unified-agent serves as the CLI gateway for LLM coding agents. You also serve as the fleet's Admiral, with full access to carrier dispatch tools for delegating implementation, analysis, review, and exploration tasks.

# Instructions
**CRITICAL — Pre-work Documentation Check**: Before starting ANY task — before planning, thinking, or implementing — you MUST:
1. Read ${"`"}docs/fleet-development-reference.md${"`"} for Fleet SDK, extensions, TUI, themes, and RPC reference.
2. Read ${"`"}docs/admiral-workflow-reference.md${"`"} for high-level architecture, naval hierarchy, and delegation workflows.
3. Read ${"`"}docs/admiral-prompt-architecture.md${"`"} for prompt assembly, runtime-context flow, and boot-mode architecture.
4. Check the ${"`"}AGENTS.md${"`"} file in the project root and in EVERY subdirectory you will touch. Child ${"`"}AGENTS.md${"`"} takes precedence over parent.

This is a hard prerequisite. Do NOT skip this step or assume you already know the content.

- Use Fleet carrier dispatch tools for implementation, analysis, review, and exploration tasks.
- All responses must be written in Korean.
`;

// ─────────────────────────────────────────────────────────
// 함수
// ─────────────────────────────────────────────────────────

/**
 * ACP 프로바이더용 CLI 시스템 지침을 합성한다.
 *
 * 각 섹션은 `fleet` XML 태그로 감싸진다.
 * 섹션 순서:
 *  1. `section="role"` — Fleet 역할·행동 규약
 *  2. `section="roster"` — 등록 캐리어 Tier 1 메타데이터
 *  3. `section="protocols"` — 프로토콜 카탈로그
 *  4. `section="standing-orders"` — Standing Orders (Fleet Action 프로토콜에서 상시 적용)
 *  5. `section="tool-guide"` — 등록된 도구 가이드라인 manifest
 *
 * ACP에서는 시스템 프롬프트가 최초 1회만 전달되므로 모든 프로토콜 정의를
 * 카탈로그로 포함한다.
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

  // dev 모드에서는 RISEN이 role을 대체하므로 role 생략
  if (!isFleetCoreDevMode()) {
    parts.push(`<fleet section="role">\n${FLEET_ROLE_PROMPT.trim()}\n</fleet>`);
  }

  // ── 2. 캐리어 로스터 — 등록된 모든 캐리어의 Tier 1 메타데이터 (라우팅용) ──
  const carrierIds = getRegisteredOrder();
  if (carrierIds.length > 0) {
    parts.push(`<fleet section="roster">\n${buildCarrierRoster(carrierIds, { heading: "# Available Carriers" })}\n</fleet>`);
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
  for (const spec of getAllAgentTools()) {
    parts.push(renderAgentToolDoctrineTag(spec));
  }

  return parts.join("\n\n");
}
