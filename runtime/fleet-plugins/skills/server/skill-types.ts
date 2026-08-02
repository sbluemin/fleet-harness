// ─── types ───────────────────────────────────────────────────────────────────

export type AgentId = "claude-code" | "codex" | "cursor" | "opencode";

export type Scope = "project" | "global";

export type JobStatus = "running" | "done" | "error";

export interface SkillListItem {
  readonly name: string;
  readonly scope: Scope;
  readonly agents: string[];
  readonly source?: string;
  readonly displayPath: string;
}

export interface SkillListResult {
  readonly skills: SkillListItem[];
}

export interface InstalledSkillSearchItem {
  readonly name: string;
  readonly scope: Scope;
}

export interface InstalledSkillSearchResult {
  readonly skills: readonly InstalledSkillSearchItem[];
}

export interface SkillSearchItem {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly installs: number;
}

export interface SkillSearchResult {
  readonly skills: SkillSearchItem[];
}

export interface JobPollResult {
  readonly lines: string[];
  readonly nextCursor: number;
  readonly status: JobStatus;
  readonly exitCode?: number;
}
