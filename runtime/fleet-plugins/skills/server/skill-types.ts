// ─── types ───────────────────────────────────────────────────────────────────

export type AgentId = "claude-code" | "codex" | "cursor" | "opencode";

export type Scope = "project" | "global";

export type JobStatus = "running" | "done" | "error";

export interface SkillListItem {
  readonly name: string;
  readonly scope: Scope;
  readonly agents: string[];
  readonly source?: string;
  /**
   * lock을 읽어냈는데 그 안에 이 스킬이 없을 때만 참이다 — 즉 "관리 밖"을 단언할 수 있을 때만.
   * lock 자체를 읽지 못했다면 source도 unmanaged도 없다: 출처는 거짓이 아니라 미상이다.
   */
  readonly unmanaged?: boolean;
  /** SKILL.md frontmatter의 description — 없으면 생략한다(빈 문자열을 만들지 않는다). */
  readonly description?: string;
  readonly displayPath: string;
}

export interface SkillListResult {
  readonly skills: SkillListItem[];
}

export type SkillPackageFileRole = "entry" | "reference" | "script" | "asset" | "file";
export type SkillPackageFileFormat = "markdown" | "code" | "text" | "unsupported";

export interface SkillPackageFile {
  readonly path: string;
  readonly name: string;
  readonly role: SkillPackageFileRole;
  readonly format: SkillPackageFileFormat;
  readonly size: number;
  readonly readable: boolean;
}

export interface SkillPackageManifest {
  readonly files: readonly SkillPackageFile[];
  readonly folderCount: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
  readonly tooLarge: boolean;
  readonly omittedSymlinks: number;
}

export interface SkillPackageResult {
  readonly manifest: SkillPackageManifest;
  readonly displayPath: string;
}

export interface SkillPackageFileResult {
  readonly content: string;
  readonly file: SkillPackageFile;
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
