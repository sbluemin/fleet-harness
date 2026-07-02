// ─── constants ───────────────────────────────────────────────────────────────

const SOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/;
const SKILL_RE = /^[a-z0-9][a-z0-9._-]*$/;
const VALID_AGENTS = new Set(["claude-code", "codex", "cursor", "opencode"]);
const VALID_SCOPES = new Set(["project", "global"]);

// ─── functions ───────────────────────────────────────────────────────────────

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateSource(source: unknown): source is string {
  return typeof source === "string" && !source.startsWith("-") && SOURCE_RE.test(source);
}

export function validateSkill(skill: unknown): skill is string {
  return typeof skill === "string" && !skill.startsWith("-") && SKILL_RE.test(skill);
}

export function validateAgent(agent: unknown): agent is string {
  return typeof agent === "string" && !agent.startsWith("-") && VALID_AGENTS.has(agent);
}

export function validateScope(scope: unknown): scope is "project" | "global" {
  return typeof scope === "string" && VALID_SCOPES.has(scope);
}
