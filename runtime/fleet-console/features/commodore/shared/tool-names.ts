/**
 * 사령관 세션의 MCP 묶음. 기억·루틴·인텔과 보드·사령관 도구가 이 하나다.
 * Console Use 기여(`console_` 이름)나 `console` 묶음으로는 싣지 않는다.
 */
export const FLEET_COMMODORE_TOOL_GROUP = "fleet-commodore";

/** 사령관 세션에 광고하는 이름. `console_` 접두 없이 역할로 부른다. */
export const BOARD_LIST_TOOL = "objectives";
export const BOARD_DETAIL_TOOL = "objective";
export const COMMODORES_TOOL = "commodores";

/**
 * 저장된 기록에 남은 옛 이름. 화면·집계는 새 이름과 같이 알아본다.
 * Console Use(부관) 기여 도구는 이 이름을 그대로 쓴다.
 */
export const LEGACY_BOARD_LIST_TOOL = "console_objectives";
export const LEGACY_BOARD_DETAIL_TOOL = "console_objectives_detail";
export const LEGACY_COMMODORES_TOOL = "console_commodores";

const COMMODORE_TOOL_RENAMES: Readonly<Record<string, string>> = {
  [LEGACY_BOARD_LIST_TOOL]: BOARD_LIST_TOOL,
  [LEGACY_BOARD_DETAIL_TOOL]: BOARD_DETAIL_TOOL,
  [LEGACY_COMMODORES_TOOL]: COMMODORES_TOOL,
};

/** defineConsoleTool 이 요구하는 `console_` 이름을 사령관 세션 광고 이름으로 옮긴다. 그 외는 그대로. */
export function commodoreSessionToolName(name: string): string {
  return COMMODORE_TOOL_RENAMES[name] ?? name;
}

/** 보드 쓰기로 세는 목록·상세. 연락·생성(`commodores`)은 세지 않는다. 옛 이름도 포함한다. */
export const BOARD_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  BOARD_LIST_TOOL, BOARD_DETAIL_TOOL, LEGACY_BOARD_LIST_TOOL, LEGACY_BOARD_DETAIL_TOOL,
]);

export const COMMODORES_TOOL_NAMES: ReadonlySet<string> = new Set([COMMODORES_TOOL, LEGACY_COMMODORES_TOOL]);

/** 화면이 읽기 action 낱말을 옮기는 보드 도구. */
export const BOARD_TOOL_NAMES: ReadonlySet<string> = new Set([...BOARD_WRITE_TOOL_NAMES, ...COMMODORES_TOOL_NAMES]);
