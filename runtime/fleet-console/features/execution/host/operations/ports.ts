import type { OperationArchiveCapability } from "../../shared/operations/archive.js";
import type { OperationCreateInput, OperationLaunchCatalogProvider, OperationNode, OperationPatchInput } from "../../shared/operations/types.js";
export type SidebarPosition = "first" | "last" | { readonly before: string } | { readonly after: string };


/** 구버전 호스트와 테스트 adapter에는 새 capability가 없을 수 있다. */
export interface OperationsHost extends Partial<OperationArchiveCapability> {
  list(): readonly OperationNode[];
  get(id: string): OperationNode | null;
  create(input: OperationCreateInput): OperationNode;
  /** 실행 호스트가 부모 안에 자식 세션을 저장한다. */
  createChild?(input: { readonly parentOperationId: string; readonly childSessionId: string; readonly payload?: Record<string, unknown> }): OperationNode;
  patch(id: string, input: OperationPatchInput): OperationNode | null;
  delete(id: string): boolean;
  /** 구성원 전용 삭제. 호스트가 바인딩한 호출 플러그인이 부모의 launchedBy와 일치해야 한다. 요청 플러그인 없이 부르는 것은 코어 실행 호스트의 롤백·정리뿐이다. */
  deleteChild?(id: string, requesterPluginId?: string): boolean;
  /** 같은 Theater·사이드바 그룹 안에서 순서를 바꾼다. unknown_operation, mixed_sections, unknown_anchor는 오류로 던진다. */
  reorder?(input: { readonly theaterId: string; readonly operationIds: readonly string[]; readonly position: SidebarPosition; readonly groupId: string | null }): { readonly operationIds: readonly string[]; readonly groupId: string | null; readonly members: readonly string[] };
  registerOperationType(type: string): () => void;
  registerPayloadSanitizer(pluginId: string, fields: readonly string[]): () => void;
  registerLaunchCatalog(pluginId: string, provider: OperationLaunchCatalogProvider): () => void;
  /**
   * Operation 그룹 — 사이드바가 Operation 을 묶는 그 그룹이다. 플러그인이 자기 목록을 따로 두는 대신 이 그룹을
   * 그대로 목록으로 쓸 수 있도록 연다. 만들기·이름·색은 사람의 PATCH 와 같은 길을 지나 영속되고
   * `group:changed` / `group:removed` 로 모든 브라우저에 닿는다. 없는 호스트(구버전·테스트 스텁)에서는 없다.
   * Operation 이 그룹을 옮기면(누가 옮겼든) 서버 안 채널 `operation:grouped`(`OperationGroupedEvent`)가 난다.
   */
  readonly groups?: OperationGroupsHost;
}


export interface OperationGroup {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly order: number;
  readonly theaterId: string;
  readonly createdAt: number;
}


export interface OperationGroupsHost {
  list(theaterId?: string): readonly OperationGroup[];
  get(id: string): OperationGroup | null;
  create(input: { readonly theaterId: string; readonly name: string; readonly color: string; readonly order?: number }): OperationGroup;
  patch(id: string, input: { readonly name?: string; readonly color?: string; readonly order?: number }): OperationGroup | null;
  /** 빈 그룹만 지운다 — 멤버가 있으면 false. */
  delete(id: string): boolean;
}
