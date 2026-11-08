import type { ConsoleCaller } from "./control.js";
import type { ConsoleActionSchema } from "./actions.js";
import type { ConsoleActionInput, ConsoleActionKind, ConsoleHumanInput, ConsoleHumanInputAct, ConsoleActionResult, ConsoleActivity, ConsoleAutomation, ConsoleAutomationInput, ConsoleControlState, ConsoleCoordinates, ConsoleCoordinatesFailureCause, ConsoleCoordinatesResult, ConsoleObjectiveObservation, ConsoleTranscriptPage, ConsoleTurnFailure, ConsoleTurnEnd, ConsoleTurnReport } from "./control.js";

/** 검증기의 원문·메시지가 아닌 필드·코드·상한만 받는 구조적 계약. */
interface ArgumentIssue {
  readonly path: readonly PropertyKey[];
  readonly code: string;
  readonly maximum?: number | bigint;
  readonly keys?: readonly string[];
  readonly errors?: readonly (readonly ArgumentIssue[])[];
}

/** 받지 않는 키 이름은 호출자가 고른 문자열이다 — 돌려주는 개수와 길이를 묶는다. */
const MAX_ISSUE_KEYS = 10;
const MAX_ISSUE_KEY_LENGTH = 64;

/**
 * 입력 원문 없이 거부된 필드와 한도를 돌려준다. union 안쪽의 한도도 보존한다. 받지 않는 키(unrecognized_keys)는
 * 값이 아니라 그 키 이름을 keys 로 싣는다 — 이름이 없으면 호출자는 어느 필드를 고쳐야 할지 추측해야 한다.
 */
export function inputIssues(issues: readonly ArgumentIssue[]): { path: readonly PropertyKey[]; code: string; maximum?: number | bigint; keys?: string[] }[] {
  return issues.flatMap((issue) => issue.code === "invalid_union" && issue.errors ? issue.errors.flatMap(inputIssues) : [{
    path: issue.path, code: issue.code,
    ...(issue.code === "too_big" ? { maximum: issue.maximum } : {}),
    ...(issue.code === "unrecognized_keys" && issue.keys ? { keys: issue.keys.slice(0, MAX_ISSUE_KEYS).map((key) => key.slice(0, MAX_ISSUE_KEY_LENGTH)) } : {}),
  }]);
}

export type { ConsoleCaller, ConsoleActionInput, ConsoleActionKind, ConsoleHumanInput, ConsoleHumanInputAct, ConsoleActionResult, ConsoleActivity, ConsoleAutomation, ConsoleAutomationInput, ConsoleControlState, ConsoleCoordinates, ConsoleCoordinatesFailureCause, ConsoleCoordinatesResult, ConsoleObjectiveObservation, ConsoleTranscriptPage, ConsoleTurnFailure, ConsoleTurnEnd, ConsoleTurnReport } from "./control.js";

/** 어느 화면 자리에 제스처가 닿는가. 내용(전사·diff·파일 본문)은 싣지 않는다 — 원격 세션도 받는 채널이다. */
export type ConsoleUseCallTarget =
  | { readonly kind: "theater"; readonly theaterId: string }
  | { readonly kind: "objectiveRecord"; readonly objectiveId: string }
  | { readonly kind: "group"; readonly groupId: string; readonly theaterId: string }
  | { readonly kind: "panel"; readonly panelId: string; readonly theaterId: string; readonly view?: string; readonly path?: string }
  /** 플러그인이 `objectiveRecordClusters` 로 낸 사이드바 묶음 줄 하나. 도구는 자기 묶음 id(Objectives 는 목표 id)를 주고, 호스트가 `<pluginId>:` 를 붙여 낸다. */
  | { readonly kind: "cluster"; readonly clusterId: string; readonly theaterId: string }
  /**
   * 한 Theater(또는 그 그룹 하나)의 묶음 줄 목록 — 목록 읽기처럼 줄 하나로 좁혀지지 않는 호출. 줄들이 모인 머리가 감싸인다.
   * 묶음 자리의 theaterId 를 비워 두면 호스트가 호출자 Objective 의 Theater 로 채운다.
   */
  | { readonly kind: "clusters"; readonly theaterId: string; readonly groupId?: string };

export interface ConsoleUseCallEvent {
  readonly caller: ConsoleCaller;
  readonly tool: string;
  /** 사람이 읽는 한 줄 — 대상 표식의 툴팁·말풍선에 그대로 나간다. 경로는 Theater 상대, 식별자는 제목으로. */
  readonly summary: string;
  readonly gesture: "gaze" | "input" | "press" | "create" | "wait";
  readonly target?: ConsoleUseCallTarget;
  /** 기여 도구가 선언한 레일 패널 — 대상이 패널이 아니어도 그 레일 아이콘이 함께 감싸인다. */
  readonly panelId?: string;
  readonly at: number;
}

export interface ConsoleMcpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /**
   * 도구의 action 선언 — `defineConsoleTool(...).plugin(...)` 이 채운다.
   */
  readonly actionSchema?: ConsoleActionSchema;
  readonly surface?: {
    readonly panelId: string;
    describe(args: Record<string, unknown>): {
      readonly theaterId: string;
      readonly summary: string;
      readonly view?: string;
      readonly path?: string;
      readonly gesture?: ConsoleUseCallEvent["gesture"];
      readonly target?: ConsoleUseCallTarget;
    } | null;
  };
  execute(args: unknown, context: {
    readonly cwd: string;
    readonly sessionLabel?: string;
    readonly toolCallId?: string;
    readonly signal?: AbortSignal;
    readonly caller?: ConsoleCaller;
    readonly commodoreId?: string;
  }): Promise<unknown>;
}
