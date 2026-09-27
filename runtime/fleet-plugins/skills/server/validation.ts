// ─── constants ───────────────────────────────────────────────────────────────

const SOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/;
const SKILL_RE = /^[a-z0-9][a-z0-9._-]*$/;
const VALID_TARGETS = new Set(["claude-code", "universal"]);
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

export function validateTarget(target: unknown): target is "claude-code" | "universal" {
  return typeof target === "string" && !target.startsWith("-") && VALID_TARGETS.has(target);
}

export function validateScope(scope: unknown): scope is "project" | "global" {
  return typeof scope === "string" && VALID_SCOPES.has(scope);
}
