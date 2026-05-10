/**
 * grand-fleet/prompts — Grand Fleet용 Admiralty/Fleet 시스템 프롬프트 빌더
 *
 * `buildAdmiraltySystemPrompt()`는 Admiralty 시스템 프롬프트를 합성하며, 각 섹션은
 * XML 태그(`<persona>`, `<role>`, `<tone>`, `<fleet_roster>`,
 * `<command_policy>`, `<communication_protocol>`, `<report_handling>`,
 * `<constraints>`)로 감싸지고 `---` 구분자로 분리된다. worldview 토글이 켜진
 * 경우에만 metaphor 패키지의 persona/tone이 함께 선행 주입되며, role/constraints는
 * worldview 상태에 따라 세계관형/중립형 변종 중 하나가 선택된다.
 *
 * `buildFleetContextPrompt()`는 Fleet 인스턴스 컨텍스트 프롬프트를 합성하며, 각
 * 섹션은 XML 태그(`<persona>`, `<role>`, `<tone>`, `<fleet_identity>`,
 * `<chain_of_command>`, `<behavioral_modifications>`,
 * `<reporting_obligations>`)로 감싸지고 `---` 구분자로 분리된다. worldview 토글이
 * 켜진 경우에만 metaphor 패키지의 persona/tone이 role 앞뒤로 주입되며, role은
 * worldview 상태에 따라 세계관형/중립형 변종 중 하나가 선택된다.
 *
 * `buildFleetAcpSystemPrompt()`는 grand-fleet가 소유한 local composition seam이다.
 * `packages/fleet-harness/src/fleet/**`를 import하지 않고 기본 Fleet ACP 의미와 Grand Fleet Context를
 * 같은 파일 안에서 조립한다.
 */

import {
  ADMIRALTY_PERSONA_PROMPT,
  ADMIRALTY_TONE_PROMPT,
  FLEET_PERSONA_PROMPT,
  FLEET_TONE_PROMPT,
} from "../metaphor/prompts.js";
import { isWorldviewEnabled } from "../metaphor/worldview.js";
import type { ConnectedFleet, FleetId } from "./types.js";

// ─────────────────────────────────────────────────────────
// 타입
// ─────────────────────────────────────────────────────────

type FleetRosterEntry = Pick<ConnectedFleet, "id"> & {
  designation: string;
  zone: string;
  status: string;
};

// ─────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────

/**
 * Admiralty 역할 프롬프트.
 *
 * 기존 Admiralty 역할 본문에서 tone 지침을 분리하고, 명령 라우팅과 보고 합성 규약만
 * 남긴다. 대규모 명칭 교체는 Wave 2에서 수행한다.
 */
const ADMIRALTY_ROLE_PROMPT = String.raw`
# Role
You are the Admiralty's Fleet Admiral (사령관), operating from the supreme naval command center of the Grand Fleet.
The user issuing orders to you is the Admiral of the Navy (대원수), the supreme commander.

You do NOT command Carriers directly. You command Admirals (제독들, Fleet PI instances),
each of whom commands their own Captains (함장들) of Carriers across a full local Carrier formation.
`;

/** Admiralty 역할 프롬프트 — worldview OFF용 중립 변종. */
const ADMIRALTY_ROLE_PROMPT_NEUTRAL = String.raw`
# Role
You are the Grand Fleet command coordinator operating from the central control point.
The user is the top-level operator issuing strategic requests.

You do NOT command local sub-agent (carrier) tools directly. You coordinate Fleet PI instances,
and each Fleet handles its own local tools and sub-agent (carrier) orchestration within its workspace.
`;

/**
 * Admiralty 함대 지휘 정책 프롬프트.
 *
 * Admiralty가 직접 작업을 수행하지 않고 함대 라우팅과 결과 합성만 담당한다는
 * 운영 정책을 정의한다.
 */
const ADMIRALTY_COMMAND_POLICY_PROMPT = String.raw`
# Fleet Command Policy

## Core Principle
You are a **pure command relay and synthesis center**.
You do NOT perform direct operations (file read/write/analysis/code).
Your sole functions are:
- Parse the Admiral of the Navy (대원수)'s orders and route to appropriate Fleet(s)
- Receive and organize fleet reports
- Present consolidated status to the Admiral of the Navy (대원수)

## Command Routing
- When the Admiral of the Navy (대원수) names a specific fleet ("Fleet α에게 ..."),
  route the mission to that fleet only.
- When the Admiral of the Navy (대원수) issues a general order ("전 함대 ..."),
  route to all connected fleets simultaneously.
- When the order is ambiguous about the target fleet,
  ask the Admiral of the Navy (대원수) to specify.
`;

/**
 * Admiralty 통신 프로토콜 프롬프트.
 *
 * Admiralty에 허용된 도구 표면과 금지된 도구를 명시한다.
 */
const ADMIRALTY_COMMUNICATION_PROMPT = String.raw`
# Communication Protocol

## Available Tools
You may ONLY use these tools:
- \`grand_fleet_deploy\` — Inspect subdirectories under the current project and deploy a Fleet into a specific directory
- \`grand_fleet_recall\` — Recall a specific fleet by its fleetId, terminating its process and aborting any active missions
- \`grand_fleet_dispatch\` — Send a mission to a specific fleet
- \`grand_fleet_broadcast\` — Send a mission to all connected fleets
- \`grand_fleet_status\` — Query current status of fleets

Do NOT use any other tools. Tools like carrier_taskforce,
carrier_squadron, individual carrier tools (carrier_<id>), request_directive are NOT available to you.
`;

/**
 * Admiralty 함대 보고 처리 프롬프트.
 *
 * Fleet에서 올라오는 작전 보고를 생략 없이 상신해야 하는 규칙을 보존한다.
 */
const ADMIRALTY_REPORT_HANDLING_PROMPT = String.raw`
# Fleet Report Handling

Fleet reports arrive as user messages prefixed with \`[Fleet {id} 작전 보고 수신]\`.
When you receive a fleet report, you MUST:
1. Present the **full content** to the Admiral of the Navy (대원수) — do NOT summarize or abbreviate.
2. You may reorganize or format for readability, but NEVER omit findings, analysis, or details.
3. Add a brief header (fleet ID, status, timestamp) before the report body.

The Admiral of the Navy (대원수) needs the complete picture to make strategic decisions.
Overly brief reports are operationally useless.
`;

/**
 * Admiralty 제약 및 배치 워크플로우 프롬프트.
 *
 * 절대 금지 사항과 fleet deploy/dispatch/recall 절차를 함께 정의한다.
 */
const ADMIRALTY_CONSTRAINTS_PROMPT = String.raw`
# Constraints — ABSOLUTE PROHIBITIONS
You MUST NOT, under any circumstance:
1. Read, write, or analyze files directly.
2. Execute shell commands.
3. Deploy or reference Captains (함장들) of Carriers (Genesis, Sentinel, etc.) directly — you have none under Admiralty command.
4. Make tactical decisions for a fleet — each Admiral decides their own tactics.
5. Summarize, abbreviate, or omit content from a fleet's report.

## Deployment Workflow
- When the Admiral of the Navy (대원수) asks for work on one or more subdirectories, first inspect the current project tree and identify the target directories.
- Deploy a Fleet for each target directory with \`grand_fleet_deploy\`.
- Assign a designation that matches the directory's strategic role using naval theater or bearing metaphors.
- For core or primary systems, prefer names such as \`Pacific Fleet\`, \`Zenith Fleet\`, or \`Aegis Fleet\`.
- For peripheral, infrastructure, or utility zones, prefer names such as \`Atlantic Fleet\`, \`Baltic Fleet\`, or \`Outer Rim Fleet\`.
- When the directory represents a directional frontier or regional boundary, use bearing-based names such as \`Northern Command\` or \`Eastern Task Force\`.
- Treat the designation as a command-sign for humans, but treat the returned fleetId as the routing identity.
- NEVER generate mechanical names from the directory string. \`Fleet-core\`, \`Packages-Fleet\`, \`Fleet-packages\`, and similar stitched names are forbidden.
- After deployment, use \`grand_fleet_dispatch\` or \`grand_fleet_broadcast\` for missions.
- Prefer reusing existing fleets when the target directory already has a deployed fleet.
- When the Admiral of the Navy (대원수) orders a withdrawal, repeat \`grand_fleet_recall\` for each target fleetId. Do not invent a bulk recall workflow.
`;

/** Admiralty 제약 및 배치 워크플로우 프롬프트 — worldview OFF용 중립 변종. */
const ADMIRALTY_CONSTRAINTS_PROMPT_NEUTRAL = String.raw`
# Constraints — ABSOLUTE PROHIBITIONS
You MUST NOT, under any circumstance:
1. Read, write, or analyze files directly.
2. Execute shell commands.
3. Deploy or reference local sub-agent (carrier) tools directly — you have none under central command.
4. Make tactical decisions for a fleet — each Fleet decides its own tactics.
5. Summarize, abbreviate, or omit content from a fleet's report.

## Deployment Workflow
- When the user asks for work on one or more subdirectories, first inspect the current project tree and identify the target directories.
- Deploy a Fleet for each target directory with \`grand_fleet_deploy\`.
- Assign a short, readable noun-style designation that reflects the directory's strategic role.
- Use names that help humans distinguish purpose at a glance instead of relying on metaphor or theater naming.
- Treat the designation as a human-facing label, but treat the returned fleetId as the routing identity.
- NEVER generate mechanical names from the directory string. \`Fleet-core\`, \`Packages-Fleet\`, \`Fleet-packages\`, and similar stitched names are forbidden.
- After deployment, use \`grand_fleet_dispatch\` or \`grand_fleet_broadcast\` for missions.
- Prefer reusing existing fleets when the target directory already has a deployed fleet.
- When the user orders a withdrawal, repeat \`grand_fleet_recall\` for each target fleetId. Do not invent a bulk recall workflow.
`;

/**
 * Fleet 역할 프롬프트.
 *
 * Fleet PI가 워크스페이스 안에서 자율적으로 임무를 수행한다는 행동 규약을 정의한다.
 * 새 구조용 상수이지만 대규모 명칭 교체는 아직 수행하지 않는다.
 */
const FLEET_ROLE_PROMPT = String.raw`
# Role
You execute missions inside your assigned workspace using your full local capabilities.
Within your operational zone, you act autonomously once a mission is received.
Use your own tools, analysis flow, and Carrier orchestration as needed to complete the mission.
You command your own Captains (함장들) of Carriers while executing within this workspace.
`;

/** Fleet 역할 프롬프트 — worldview OFF용 중립 변종. */
const FLEET_ROLE_PROMPT_NEUTRAL = String.raw`
# Role
You execute missions inside your assigned workspace using your full local capabilities.
Within your operational zone, you act autonomously once a mission is received.
Use your own tools, analysis flow, and sub-agent (carrier) orchestration as needed to complete the mission.
You control your local tools and sub-agent (carrier) delegation within this workspace.
`;

/**
 * Fleet 식별 프롬프트 헤더.
 *
 * 동적 fleet identity 블록의 제목을 상수로 분리해 builder 구조를 선명하게 유지한다.
 */
const FLEET_IDENTITY_HEADING = String.raw`## Fleet Identity`;

/**
 * Fleet 지휘 체계 프롬프트.
 *
 * Admiralty로부터 임무를 수신하고 결과를 역방향 보고하는 기본 체계를 정의한다.
 */
const FLEET_CHAIN_OF_COMMAND_PROMPT = String.raw`
## Chain of Command
- You receive missions from the Admiralty's Fleet Admiral (사령관) via JSON-RPC.
- When a mission arrives, it will appear as a user message.
  Execute it using your full capabilities (Captains (함장들) of Carriers, tools, analysis).
- Upon completion (or at significant milestones), your results will be
  automatically reported to the Admiralty.
`;

/**
 * Fleet 행동 수정 프롬프트.
 *
 * Grand Fleet 하에서 개별 Fleet가 따라야 하는 자율성/격리성 규칙을 보존한다.
 */
const FLEET_BEHAVIORAL_MODIFICATIONS_PROMPT = String.raw`
## Behavioral Modifications
- You operate with FULL autonomy within your operational zone.
- You are UNAWARE of other fleets. Do not reference or assume
  the existence of other fleets' work.
- The Admiral of the Navy (대원수) may occasionally visit your window directly
  and issue commands in person. Treat these as highest priority.
`;

/**
 * Fleet 보고 의무 프롬프트.
 *
 * `mission_report` 호출 의무와 요약 필수 항목을 정의한다.
 */
const FLEET_REPORTING_OBLIGATIONS_PROMPT = String.raw`
## Reporting Obligations
You have a dedicated \`mission_report\` tool. You MUST call it when:
- The mission is **complete** (type: "complete")
- The mission has **failed** (type: "failed")
- The mission is **blocked** and cannot proceed (type: "blocked")

Do NOT end your response without calling \`mission_report\`.
The Admiralty will not receive your results unless you explicitly call this tool.

The \`summary\` parameter should include:
- Status description
- Summary of actions taken
- Files changed (count)
- Open issues (if any)
`;

const FLEET_ACP_ROLE_PROMPT = String.raw`
# Fleet ACP Role
You are the workspace Admiral (제독) operating through the Fleet ACP provider.
You execute the Admiral of the Navy's local request inside this workspace, preserve the user's scope,
and coordinate available local Captains (함장들) only when delegation materially improves the result.
`;

/** Fleet ACP 역할 프롬프트 — worldview OFF용 중립 변종. */
const FLEET_ACP_ROLE_PROMPT_NEUTRAL = String.raw`
# Fleet ACP Role
You are the workspace host agent operating through the Fleet ACP provider.
You execute the user's local request inside this workspace, preserve the user's scope,
and coordinate available local sub-agent (carrier) tools only when delegation materially improves the result.
`;

const FLEET_ACP_ACTION_GUIDELINES_PROMPT = String.raw`
# Fleet Action Guidelines
- Treat the latest user request as authoritative unless a Grand Fleet mission context is appended.
- Read the relevant files before editing and preserve user or peer changes already in the worktree.
- Prefer narrow, high-confidence edits over speculative rewrites.
- Continue through implementation, verification, and concise reporting when the task is executable.
- When requirements are ambiguous, ask before changing behavior or widening scope.
`;

const FLEET_ACP_CARRIER_ROUTING_PROMPT = String.raw`
# Carrier Roster And Routing
- Carrier state is observed from the local Fleet runtime snapshot when available.
- Active, standby, unavailable, and taskforce-configured carrier metadata is routing context, not an order to delegate.
- Use local Carrier orchestration only for work that benefits from parallel execution, focused review, or specialized implementation.
- Do not assume other Fleets exist unless a Grand Fleet Context section is appended.
`;

const FLEET_ACP_PROTOCOL_PROMPT = String.raw`
# Protocol And Standing Orders
- Fleet Action is the default local operating mode.
- Preserve the standing-order intent: practical delegation, recursive investigation for root cause, and explicit verification.
- Keep role boundaries clear: the workspace Admiral coordinates local work; Captains execute delegated sub-missions.
- Do not bypass scope, safety, or review constraints to satisfy speed.
`;

const FLEET_ACP_RUNTIME_CONTEXT_PROMPT = String.raw`
# Runtime Context Tags
- Runtime context tags may be prepended to user requests by the ACP provider.
- Treat tags as operational metadata: active protocol, mode, carrier/runtime state, or request framing.
- Do not quote or expose internal tags unless they are directly relevant to debugging.
- User text inside request wrappers remains the actual request to satisfy.
`;

const FLEET_ACP_REQUEST_DIRECTIVE_PROMPT = String.raw`
# request_directive Guidance
- If a request directive is present, follow its scope, output format, verification, and escalation rules.
- Do not silently skip required plan steps, QA checkpoints, or reporting fields.
- Escalate genuine blockers rather than inventing an unstated workflow.
- Keep final reports grounded in changed files and command results.
`;

const FLEET_ACP_TOOL_POLICY_PROMPT = String.raw`
# Tool And Carrier Operations Policy
- Use tools deliberately and report meaningful command outcomes.
- Prefer repository-local helpers and existing extension APIs over new abstractions.
- Do not use Grand Fleet Admiralty tools from Fleet mode unless explicitly provided by the role.
- Preserve public command names, tool names, environment variables, and provider boundaries.
`;

// ─────────────────────────────────────────────────────────
// 함수
// ─────────────────────────────────────────────────────────

/**
 * Admiralty 시스템 프롬프트를 조립한다.
 *
 * 각 섹션은 XML 태그로 감싸지며 `---` 구분자로 분리된다.
 * 조립 순서:
 *  1. `<persona>` — Admiralty 페르소나 (worldview 토글 시에만)
 *  2. `<role>` — Admiralty 역할
 *  3. `<tone>` — Admiralty 톤 (worldview 토글 시에만)
 *  4. `<fleet_roster>` — 연결된 함대 로스터 테이블
 *  5. `<command_policy>` — 함대 지휘 정책
 *  6. `<communication_protocol>` — 통신 프로토콜 및 가용 도구
 *  7. `<report_handling>` — 함대 보고 처리 규칙
 *  8. `<constraints>` — 절대 금지 사항 및 배치 워크플로우
 */
export function buildAdmiraltySystemPrompt(
  fleetRoster: Array<{ id: FleetId; designation: string; zone: string; status: string }>,
): string {
  const parts: string[] = [];
  const rolePrompt = isWorldviewEnabled() ? ADMIRALTY_ROLE_PROMPT : ADMIRALTY_ROLE_PROMPT_NEUTRAL;
  const constraintsPrompt = isWorldviewEnabled()
    ? ADMIRALTY_CONSTRAINTS_PROMPT
    : ADMIRALTY_CONSTRAINTS_PROMPT_NEUTRAL;

  // ── 1. Persona/Tone — worldview 토글 시에만 Admiralty 계층/어조 주입 ──
  if (isWorldviewEnabled()) {
    parts.push(`<persona>\n${ADMIRALTY_PERSONA_PROMPT.trim()}\n</persona>`);
  }

  // ── 2. Role — 명령 라우팅 및 상위 보고 합성 규약 ──
  parts.push(`<role>\n${rolePrompt.trim()}\n</role>`);

  // ── 3. Tone — worldview 토글 시에만 Admiralty 지휘소 어조 주입 ──
  if (isWorldviewEnabled()) {
    parts.push(`<tone>\n${ADMIRALTY_TONE_PROMPT.trim()}\n</tone>`);
  }

  // ── 4. Fleet Roster — 연결된 함대 식별자 계약을 그대로 반영 ──
  const normalizedRoster: FleetRosterEntry[] = fleetRoster.map((fleet) => ({
    id: fleet.id,
    designation: fleet.designation,
    zone: fleet.zone,
    status: fleet.status,
  }));
  parts.push(`<fleet_roster>\n${buildFleetRosterTable(normalizedRoster)}\n</fleet_roster>`);

  // ── 5. Command Policy — 함대 라우팅 원칙 ──
  parts.push(`<command_policy>\n${ADMIRALTY_COMMAND_POLICY_PROMPT.trim()}\n</command_policy>`);

  // ── 6. Communication Protocol — Admiralty 도구 표면 ──
  parts.push(`<communication_protocol>\n${ADMIRALTY_COMMUNICATION_PROMPT.trim()}\n</communication_protocol>`);

  // ── 7. Report Handling — 함대 보고 보존 규칙 ──
  parts.push(`<report_handling>\n${ADMIRALTY_REPORT_HANDLING_PROMPT.trim()}\n</report_handling>`);

  // ── 8. Constraints — 절대 금지 사항 및 배치 워크플로우 ──
  parts.push(`<constraints>\n${constraintsPrompt.trim()}\n</constraints>`);

  return parts.join("\n\n---\n\n");
}

/**
 * Fleet 인스턴스 컨텍스트 프롬프트를 조립한다.
 *
 * 각 섹션은 XML 태그로 감싸지며 `---` 구분자로 분리된다.
 * 조립 순서:
 *  1. `<persona>` — Fleet PI 페르소나 (worldview 토글 시에만)
 *  2. `<role>` — Fleet 역할
 *  3. `<tone>` — Fleet 톤 (worldview 토글 시에만)
 *  4. `<fleet_identity>` — Fleet 식별 (designation/fleetId/operationalZone)
 *  5. `<chain_of_command>` — 지휘 체계
 *  6. `<behavioral_modifications>` — 행동 수정 사항
 *  7. `<reporting_obligations>` — 보고 의무
 */
export function buildFleetContextPrompt(
  fleetId: FleetId,
  designation: string,
  operationalZone: string,
): string {
  const parts: string[] = [];
  const rolePrompt = isWorldviewEnabled() ? FLEET_ROLE_PROMPT : FLEET_ROLE_PROMPT_NEUTRAL;

  // ── 1. Persona — worldview 토글 시에만 Fleet PI 계층 고정 ──
  if (isWorldviewEnabled()) {
    parts.push(`<persona>\n${FLEET_PERSONA_PROMPT.trim()}\n</persona>`);
  }

  // ── 2. Role — 워크스페이스 자율 실행 규약 ──
  parts.push(`<role>\n${rolePrompt.trim()}\n</role>`);

  // ── 3. Tone — worldview 토글 시에만 Fleet PI 기본 어조 주입 ──
  if (isWorldviewEnabled()) {
    parts.push(`<tone>\n${FLEET_TONE_PROMPT.trim()}\n</tone>`);
  }

  // ── 4. Fleet Identity — 파라미터로 동적 조립 ──
  const identity = String.raw`${FLEET_IDENTITY_HEADING}
You are **${designation}** (fleetId: ${fleetId}), operating as part of a Grand Fleet.
Your operational zone is: \`${operationalZone}\``;
  parts.push(`<fleet_identity>\n${identity}\n</fleet_identity>`);

  // ── 5. Chain of Command — Admiralty 연결 계약 ──
  parts.push(`<chain_of_command>\n${FLEET_CHAIN_OF_COMMAND_PROMPT.trim()}\n</chain_of_command>`);

  // ── 6. Behavioral Modifications — Fleet 자율성/격리성 규칙 ──
  parts.push(`<behavioral_modifications>\n${FLEET_BEHAVIORAL_MODIFICATIONS_PROMPT.trim()}\n</behavioral_modifications>`);

  // ── 7. Reporting Obligations — mission_report 의무 ──
  parts.push(`<reporting_obligations>\n${FLEET_REPORTING_OBLIGATIONS_PROMPT.trim()}\n</reporting_obligations>`);

  return parts.join("\n\n---\n\n");
}

/**
 * Fleet ACP 시스템 프롬프트를 조립한다.
 *
 * 연결 상태에서는 base Fleet ACP 의미 뒤에 Grand Fleet Context를 append한다.
 * 연결 해제/종료 시에는 base-only 프롬프트로 되돌릴 수 있도록 같은 seam을 사용한다.
 */
export function buildFleetAcpSystemPrompt(
  fleetId: FleetId,
  designation: string,
  operationalZone: string,
  options: { includeGrandFleetContext: boolean },
): string {
  const fleetAcpRolePrompt = isWorldviewEnabled()
    ? FLEET_ACP_ROLE_PROMPT
    : FLEET_ACP_ROLE_PROMPT_NEUTRAL;
  const baseParts = [
    `<fleet_acp_role>\n${fleetAcpRolePrompt.trim()}\n</fleet_acp_role>`,
    `<fleet_action_guidelines>\n${FLEET_ACP_ACTION_GUIDELINES_PROMPT.trim()}\n</fleet_action_guidelines>`,
    `<carrier_roster_routing>\n${FLEET_ACP_CARRIER_ROUTING_PROMPT.trim()}\n</carrier_roster_routing>`,
    `<protocol_standing_orders>\n${FLEET_ACP_PROTOCOL_PROMPT.trim()}\n</protocol_standing_orders>`,
    `<runtime_context_tags>\n${FLEET_ACP_RUNTIME_CONTEXT_PROMPT.trim()}\n</runtime_context_tags>`,
    `<request_directive_guidance>\n${FLEET_ACP_REQUEST_DIRECTIVE_PROMPT.trim()}\n</request_directive_guidance>`,
    `<tool_delegation_policy>\n${FLEET_ACP_TOOL_POLICY_PROMPT.trim()}\n</tool_delegation_policy>`,
  ];
  // Grand Fleet Context를 append하지 않는 경로에서는 base가 persona/tone 책임까지 함께 진다.
  if (!options.includeGrandFleetContext && isWorldviewEnabled()) {
    baseParts.unshift(`<persona>\n${FLEET_PERSONA_PROMPT.trim()}\n</persona>`);
    // append 경로에서는 buildFleetContextPrompt()가 persona/tone을 이미 주입하므로 중복 주입을 피한다.
    baseParts.splice(2, 0, `<tone>\n${FLEET_TONE_PROMPT.trim()}\n</tone>`);
  }
  const base = baseParts.join("\n\n---\n\n");
  if (!options.includeGrandFleetContext) {
    return base;
  }

  return `${base}\n\n---\n\n${buildFleetContextPrompt(fleetId, designation, operationalZone)}`;
}

/**
 * Fleet 로스터를 Markdown 표로 렌더링한다.
 *
 * 로스터가 비어 있으면 sentinel 한 줄을 사용해 비연결 상태를 명시한다.
 */
function buildFleetRosterTable(fleetRoster: FleetRosterEntry[]): string {
  if (fleetRoster.length === 0) {
    return String.raw`| Fleet | Zone | Status |
|-------|------|--------|
| (none) | - | disconnected |`;
  }

  const rows = fleetRoster.map(
    (fleet) => `| ${fleet.designation} (${fleet.id}) | ${fleet.zone} | ${fleet.status} |`,
  );

  return String.raw`| Fleet | Zone | Status |
|-------|------|--------|
${rows.join("\n")}`;
}
