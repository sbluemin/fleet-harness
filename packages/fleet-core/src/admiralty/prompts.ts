/**
 * grand-fleet/prompts — Grand Fleet용 Admiralty/Fleet 시스템 프롬프트 빌더
 *
 * `buildAdmiraltySystemPrompt()`는 Admiralty 시스템 프롬프트를 합성하며, 각 섹션은
 * XML 태그(`<role>`, `<fleet_roster>`,
 * `<command_policy>`, `<communication_protocol>`, `<report_handling>`,
 * `<constraints>`)로 감싸지고 `---` 구분자로 분리된다.
 *
 * `buildFleetContextPrompt()`는 Fleet 인스턴스 컨텍스트 프롬프트를 합성하며, 각
 * 섹션은 XML 태그(`<role>`, `<fleet_identity>`,
 * `<chain_of_command>`, `<behavioral_modifications>`,
 * `<reporting_obligations>`)로 감싸지고 `---` 구분자로 분리된다.
 *
 * `buildFleetAcpSystemPrompt()`는 grand-fleet가 소유한 local composition seam이다.
 * 외부 호스트 조립 코드에 의존하지 않고 기본 Fleet ACP 의미와 Grand Fleet Context를
 * 이 파일 안에서 조립한다.
 */

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

/** Admiralty 역할 프롬프트. */
const ADMIRALTY_ROLE_PROMPT = String.raw`
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

Do NOT use any other tools. Tools like carrier_taskforce and individual carrier tools (carrier_<id>) are NOT available to you.
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

/** Admiralty 제약 및 배치 워크플로우 프롬프트. */
const ADMIRALTY_CONSTRAINTS_PROMPT = String.raw`
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
- Use names that help humans distinguish purpose at a glance.
- Treat the designation as a human-facing label, but treat the returned fleetId as the routing identity.
- NEVER generate mechanical names from the directory string. \`Fleet-core\`, \`Packages-Fleet\`, \`Fleet-packages\`, and similar stitched names are forbidden.
- After deployment, use \`grand_fleet_dispatch\` or \`grand_fleet_broadcast\` for missions.
- Prefer reusing existing fleets when the target directory already has a deployed fleet.
- When the user orders a withdrawal, repeat \`grand_fleet_recall\` for each target fleetId. Do not invent a bulk recall workflow.
`;

/** Fleet 역할 프롬프트. */
const FLEET_ROLE_PROMPT = String.raw`
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
 *  1. `<role>` — Admiralty 역할
 *  2. `<fleet_roster>` — 연결된 함대 로스터 테이블
 *  3. `<command_policy>` — 함대 지휘 정책
 *  4. `<communication_protocol>` — 통신 프로토콜 및 가용 도구
 *  5. `<report_handling>` — 함대 보고 처리 규칙
 *  6. `<constraints>` — 절대 금지 사항 및 배치 워크플로우
 */
export function buildAdmiraltySystemPrompt(
  fleetRoster: Array<{ id: FleetId; designation: string; zone: string; status: string }>,
): string {
  const parts: string[] = [];

  // ── 1. Role — 명령 라우팅 및 상위 보고 합성 규약 ──
  parts.push(`<role>\n${ADMIRALTY_ROLE_PROMPT.trim()}\n</role>`);

  // ── 2. Fleet Roster — 연결된 함대 식별자 계약을 그대로 반영 ──
  const normalizedRoster: FleetRosterEntry[] = fleetRoster.map((fleet) => ({
    id: fleet.id,
    designation: fleet.designation,
    zone: fleet.zone,
    status: fleet.status,
  }));
  parts.push(`<fleet_roster>\n${buildFleetRosterTable(normalizedRoster)}\n</fleet_roster>`);

  // ── 3. Command Policy — 함대 라우팅 원칙 ──
  parts.push(`<command_policy>\n${ADMIRALTY_COMMAND_POLICY_PROMPT.trim()}\n</command_policy>`);

  // ── 4. Communication Protocol — Admiralty 도구 표면 ──
  parts.push(`<communication_protocol>\n${ADMIRALTY_COMMUNICATION_PROMPT.trim()}\n</communication_protocol>`);

  // ── 5. Report Handling — 함대 보고 보존 규칙 ──
  parts.push(`<report_handling>\n${ADMIRALTY_REPORT_HANDLING_PROMPT.trim()}\n</report_handling>`);

  // ── 6. Constraints — 절대 금지 사항 및 배치 워크플로우 ──
  parts.push(`<constraints>\n${ADMIRALTY_CONSTRAINTS_PROMPT.trim()}\n</constraints>`);

  return parts.join("\n\n---\n\n");
}

/**
 * Fleet 인스턴스 컨텍스트 프롬프트를 조립한다.
 *
 * 각 섹션은 XML 태그로 감싸지며 `---` 구분자로 분리된다.
 * 조립 순서:
 *  1. `<role>` — Fleet 역할
 *  2. `<fleet_identity>` — Fleet 식별 (designation/fleetId/operationalZone)
 *  3. `<chain_of_command>` — 지휘 체계
 *  4. `<behavioral_modifications>` — 행동 수정 사항
 *  5. `<reporting_obligations>` — 보고 의무
 */
export function buildFleetContextPrompt(
  fleetId: FleetId,
  designation: string,
  operationalZone: string,
): string {
  const parts: string[] = [];

  // ── 1. Role — 워크스페이스 자율 실행 규약 ──
  parts.push(`<role>\n${FLEET_ROLE_PROMPT.trim()}\n</role>`);

  // ── 2. Fleet Identity — 파라미터로 동적 조립 ──
  const identity = String.raw`${FLEET_IDENTITY_HEADING}
You are **${designation}** (fleetId: ${fleetId}), operating as part of a Grand Fleet.
Your operational zone is: \`${operationalZone}\``;
  parts.push(`<fleet_identity>\n${identity}\n</fleet_identity>`);

  // ── 3. Chain of Command — Admiralty 연결 계약 ──
  parts.push(`<chain_of_command>\n${FLEET_CHAIN_OF_COMMAND_PROMPT.trim()}\n</chain_of_command>`);

  // ── 4. Behavioral Modifications — Fleet 자율성/격리성 규칙 ──
  parts.push(`<behavioral_modifications>\n${FLEET_BEHAVIORAL_MODIFICATIONS_PROMPT.trim()}\n</behavioral_modifications>`);

  // ── 5. Reporting Obligations — mission_report 의무 ──
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
  const baseParts = [
    `<fleet_acp_role>\n${FLEET_ACP_ROLE_PROMPT.trim()}\n</fleet_acp_role>`,
    `<fleet_action_guidelines>\n${FLEET_ACP_ACTION_GUIDELINES_PROMPT.trim()}\n</fleet_action_guidelines>`,
    `<carrier_roster_routing>\n${FLEET_ACP_CARRIER_ROUTING_PROMPT.trim()}\n</carrier_roster_routing>`,
    `<protocol_standing_orders>\n${FLEET_ACP_PROTOCOL_PROMPT.trim()}\n</protocol_standing_orders>`,
    `<tool_delegation_policy>\n${FLEET_ACP_TOOL_POLICY_PROMPT.trim()}\n</tool_delegation_policy>`,
  ];
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
