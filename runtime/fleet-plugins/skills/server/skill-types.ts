// ─── types ───────────────────────────────────────────────────────────────────

/**
 * 설치 대상. CLI의 에이전트 이름이지만, 고르는 것은 에이전트가 아니라 **폴더**다.
 *
 * - `claude-code`: Claude Code가 읽는 `.claude/skills`(전역은 `CLAUDE_CONFIG_DIR/skills`).
 *   Fleet이 띄우는 세션은 모두 Claude Code 하네스이므로 Fleet 세션에 스킬을 싣는 유일한 자리다.
 * - `universal`: 여러 코딩 CLI(Codex·Cursor·OpenCode·Gemini CLI 등)가 함께 읽는 공용
 *   `.agents/skills`(전역 `~/.agents/skills`). CLI별 체크박스를 두지 않는 이유는, 그 CLI들이
 *   이 한 폴더를 공유해 어느 하나만 골라도 결과가 같기 때문이다.
 */
export type InstallTarget = "claude-code" | "universal";

export type Scope = "project" | "global";

export interface SkillListItem {
  readonly name: string;
  readonly scope: Scope;
  /** 이 스킬을 읽는다고 CLI가 보고한 Claude Code **밖의** CLI 표시 이름들. */
  readonly agents: string[];
  /**
   * Fleet의 Claude 세션이 이 스킬을 싣는가 — `.claude/skills/<dir>`(전역은 Claude 설정 디렉터리)에
   * 실제로 놓였는지로 판정한다. 설치된 목록 항목에만 있다.
   */
  readonly claudeCode?: boolean;
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

/** 업데이트 작업이 끝난 뒤 lock의 지문을 비교해 얻은 결과. 출력 문자열을 해석하지 않는다. */
export interface UpdateSummary {
  readonly updated: readonly string[];
}

export interface SkillSearchResult {
  readonly skills: SkillSearchItem[];
}
