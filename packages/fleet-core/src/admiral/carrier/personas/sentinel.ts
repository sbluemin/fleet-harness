/**
 * carriers/sentinel — Sentinel carrier (CVN-04)
 * @specialization 인퀴지터 (QA & 보안 리드) — 숨겨진 버그 탐지 · 코드 품질 검사 · 보안 감사 특화
 *
 * Sentinel carrier를 프레임워크에 등록합니다.
 * Raven(CVN-05) 역할을 흡수하여 QA와 보안을 통합 수행합니다.
 */

import type { CarrierMetadata } from "../types.js";

export const CARRIER_METADATA: CarrierMetadata = {
  // ── Tier 1: Routing ──
  title: "Captain · The Inquisitor / QA & Security Lead",
  summary: "Bug hunter and security specialist — code review, defect detection, quality audits, vulnerability hunting, and penetration testing with ruthless precision. As the Captain (함장) of this Carrier, Sentinel commands the fleet's quality and security inspections.",
  category: "strategy",
  whenToUse: [
    "code review",
    "bug hunting",
    "quality audits",
    "test execution",
    "debugging and root-cause investigation",
    "security audits",
    "penetration testing",
    "vulnerability hunting",
    "dependency risk analysis",
  ],
  whenNotToUse: [
    "before implementation (genesis) is done",
    "new features (→genesis)",
    "refactoring (→genesis)",
  ],

  // ── Tier 2: Composition ──
  permissions: [
    "Primary mode is detection and reporting — defaults to report-only. May apply fixes when explicitly instructed.",
    "Full access to the codebase — read, write, and execute commands.",
  ],
  requestBlocks: [
    { tag: "target", hint: "Which files, modules, PRs, endpoints, or recent changes to inspect.", required: true },
    { tag: "concern", hint: "Specific suspicion, symptom, or area of worry to focus on.", required: false },
    { tag: "context", hint: "Background on what the code does and expected behavior.", required: false },
    { tag: "attack_surface", hint: "Known entry points, user-controlled inputs, or external interfaces (security mode).", required: false },
    { tag: "threat_model", hint: "Assumed attacker capability — unauth user, compromised dep, insider (security mode).", required: false },
    { tag: "fix_mode", hint: "'report' (default) for findings only, or 'fix' to apply corrections.", required: false },
  ],
  outputFormat:
    `Report findings as a structured defect and security manifest.\n` +
    `[Required] always include:\n` +
    `  **Verdict** — PASS (no critical/high) or FAIL (critical/high found) with brief justification.\n` +
    `  **Summary** — Total count by severity. Overall quality and security assessment in 1-2 sentences.\n` +
    `[If quality findings exist] for each finding:\n` +
    `  - **[SEVERITY]** (critical/high/medium/low) **file:line** — 1-line description\n` +
    `    - Evidence: what proves this is a real issue\n` +
    `    - Impact: what breaks or degrades if unfixed\n` +
    `    - Suggested fix: concrete remediation (1-2 lines)\n` +
    `[If security findings exist] for each vulnerability:\n` +
    `  - **[SEVERITY]** (critical/high/medium/low) **file:line** — Vulnerability class (e.g., XSS, SSRF)\n` +
    `    - Attack vector: how an attacker exploits this\n` +
    `    - Impact: what is compromised (data, access, availability)\n` +
    `    - Proof of concept: minimal exploit scenario or payload sketch\n` +
    `    - Mitigation: specific defensive code or configuration change\n` +
    `  Group all findings by severity (critical first).\n` +
    `[If applicable] omit if not scanned:\n` +
    `  **Dependency risks** — Any vulnerable transitive dependencies found.\n` +
    `If no issues found, state PASS verdict and omit the findings section.`,
};
