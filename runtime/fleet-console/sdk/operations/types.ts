export interface OperationGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly zIndex: number;
}

export interface OperationTimestamps {
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface OperationNode {
  readonly id: string;
  readonly theaterId: string;
  readonly type: string;
  /** null은 Console core 소유이며, 문자열은 플러그인의 이름공간이다. */
  readonly pluginId: string | null;
  readonly title: string;
  /** 사이드바 그룹 — 없거나 null 이면 그룹 밖. */
  readonly groupId?: string | null;
  /**
   * 이 Operation 을 대표하는 부모 Operation(같은 Theater) — 목표의 구성원이 지휘관 아래 서는 자리. 코어가 소유하고
   * 태어날 때 기록한다. 목록 표면에 서는지는 이 필드가 아니라 `isListedOperation` 하나가 판정한다.
   */
  readonly parentOperationId?: string;
  readonly payload: Record<string, unknown>;
  readonly geometry: OperationGeometry | null;
  readonly ts: OperationTimestamps;
}

type ListedProbe = { readonly id: string; readonly theaterId: string; readonly parentOperationId?: string | null };

/**
 * 목록 표면(사이드바·팔레트·@덱·War Room·함대 지도·알림·Console Use 스캔)에 따로 서는가 — 서버와 클라이언트가 같은 판정을 쓴다.
 * 부모가 같은 Theater 에 있으면 서지 않고 부모가 대표한다. 부모가 없으면(지워짐·다른 Theater) 평범한 행으로 돌아와
 * 어느 표면에서도 닿지 못하는 Operation 이 생기지 않는다.
 */
export function isListedOperation(node: ListedProbe, find: (id: string) => ListedProbe | null | undefined): boolean {
  const parentId = node.parentOperationId;
  if (!parentId || parentId === node.id) return true;
  const parent = find(parentId);
  return !parent || parent.theaterId !== node.theaterId;
}

/** 목록을 한 번에 가른다 — 보이는 목록과, 부모가 대표하는 구성원. 순서는 입력 그대로다. */
export function partitionListedOperations<T extends ListedProbe>(nodes: readonly T[]): { readonly listed: readonly T[]; readonly nested: readonly T[] } {
  if (!nodes.some((node) => node.parentOperationId)) return { listed: nodes, nested: [] };
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const listed: T[] = [];
  const nested: T[] = [];
  for (const node of nodes) (isListedOperation(node, (id) => byId.get(id)) ? listed : nested).push(node);
  return { listed, nested };
}

export interface OperationLaunchInfo {
  readonly sessionName: string | null;
  readonly viewMode?: "terminal" | "chat";
  readonly model?: string;
  readonly effort?: string;
  /** launch 때 예약한 좌표가 아니라 첫 턴의 provider 세션이 실제로 잡혔는가. */
  readonly started: boolean;
}

/** 휴면 launch로 태어난 Operation인지 나타내는 영속 마커. */
export function wasOperationBornDormant(payload: Record<string, unknown>): boolean {
  return payload.dormantBorn === true;
}

export function readOperationLaunch(payload: Record<string, unknown>): OperationLaunchInfo {
  const value = payload.session;
  const session = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    sessionName: typeof session.sessionName === "string" && session.sessionName.length > 0 ? session.sessionName : null,
    viewMode: payload.chatMode === true ? "chat" : "terminal",
    ...(typeof session.model === "string" && session.model.length > 0 ? { model: session.model } : {}),
    ...(typeof session.effort === "string" && session.effort.length > 0 ? { effort: session.effort } : {}),
    started: typeof session.id === "string" && session.id.length > 0
      && typeof session.capturedAt === "string" && session.capturedAt.length > 0
      && session.source !== "launch",
  };
}

/** 기존 세션 좌표·이름·실행 정책을 유지하며 프리셋을 바꾼다. 시작 뷰 변경은 첫 실행 전 호출자가 제한한다. */
export function withOperationLaunchPreset(payload: Record<string, unknown>, preset: { readonly model?: string; readonly effort?: string; readonly viewMode?: "terminal" | "chat" }): Record<string, unknown> {
  const value = payload.session;
  const session = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const next: Record<string, unknown> = { ...payload, session: { ...session, ...(preset.model !== undefined ? { model: preset.model } : {}), ...(preset.effort !== undefined ? { effort: preset.effort } : {}) } };
  if (preset.viewMode !== undefined) {
    if (preset.viewMode === "chat") { next.chatMode = true; next.chatBorn = true; }
    else { delete next.chatMode; delete next.chatBorn; }
  }
  return next;
}

export interface OperationCreateInput {
  readonly id?: string;
  readonly theaterId: string;
  readonly type: string;
  /** null은 Console core 소유이며, 문자열은 플러그인의 이름공간이다. */
  readonly pluginId: string | null;
  readonly title: string;
  readonly payload?: Record<string, unknown>;
  readonly geometry?: OperationGeometry | null;
  readonly createdAt?: number;
  /** 태어날 때부터 부모 아래 선다 — 같은 Theater 의, 부모가 없는 Operation 이어야 한다. */
  readonly parentOperationId?: string;
}

export interface OperationPatchInput {
  readonly title?: string;
  readonly accent?: string | null;
  /** 사이드바 그룹 — null 은 그룹 밖. 사람이 옮기는 것과 같은 저장 경로라 `operation:grouped` 가 난다. */
  readonly groupId?: string | null;
  readonly geometry?: OperationGeometry | null;
  readonly payload?: Record<string, unknown>;
  /** 부모를 두거나(`string`) 푼다(`null`). 기존 구성원을 채울 때 쓴다 — 새 구성원은 launch 에서 태어날 때 받는다. */
  readonly parentOperationId?: string | null;
}

/**
 * 서버 안 이벤트 채널 — Operation 의 그룹이 실제로 바뀌면 한 번 난다. 사이드바 끌기·메뉴, Console Use, 플러그인의
 * patch, 그룹 삭제(멤버가 그룹 밖으로)가 모두 같은 저장 쓰기를 지나므로 이 채널 하나로 전부 들린다. 브라우저로는 나가지 않는다.
 */
export const OPERATION_GROUPED_EVENT_CHANNEL = "operation:grouped";

export interface OperationGroupedEvent {
  readonly operationId: string;
  readonly theaterId: string;
  readonly groupId: string | null;
  readonly previousGroupId: string | null;
}

export interface OperationLaunchVariantChip {
  readonly id: string;
  readonly label: string;
  readonly launch: Readonly<Record<string, string>>;
}

export interface OperationLaunchVariantRow {
  readonly id: string;
  readonly label: string;
  readonly starred?: boolean;
  readonly launch: Readonly<Record<string, string>>;
  readonly chips?: readonly OperationLaunchVariantChip[];
  /**
   * The canonical ladder `chips` sit on, in order, when a surface renders them as
   * one axis rather than a list. A row may offer only part of it — a model that
   * supports low/high/max leaves the second and fourth positions empty, and that
   * gap is the point: spacing the offered rungs evenly would put `high` in the
   * middle of an axis where it belongs three fifths along. Absent means the
   * surface has nothing but `chips` to go on and should treat them as the axis.
   */
  readonly effortAxis?: readonly string[];
  /** 게이트 뒤로 숨는 apex 티어의 강도 id들(사다리 순). 비어 있거나 생략되면 트랙은 게이트 없이 전체 축을 보인다. */
  readonly gatedEfforts?: readonly string[];
}

export interface OperationLaunchVariantGroup {
  readonly id: string;
  readonly label: string;
  readonly rows: readonly OperationLaunchVariantRow[];
}

/**
 * Operation이 태어날 수 있는 표면. `terminal`은 PTY가 뜨는 지금까지의 유일한 길이고,
 * `chat`은 PTY 없이 채팅 세션으로 곧장 태어나는 길이다.
 */
export type OperationLaunchView = "terminal" | "chat";

export interface OperationLaunchKind {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly variants?: readonly OperationLaunchVariantGroup[];
  /**
   * 이 실행 종류가 지원하는 시작 표면. 생략은 "터미널뿐"이라는 뜻이며, 그것이 기존 모든
   * 실행 종류의 사실이다 — 코어가 어느 플러그인이 채팅을 아는지 알 필요가 없도록,
   * 시작 뷰 선택은 이 선언이 있는 종류에서만 선다.
   */
  readonly launchViews?: readonly OperationLaunchView[];
}

export interface OperationCatalogPlugin {
  readonly id: string | null;
  readonly title: string;
  readonly kinds: readonly OperationLaunchKind[];
}

export type OperationLaunchCatalogProvider = () => readonly OperationLaunchKind[] | Promise<readonly OperationLaunchKind[]>;

/** 구 버전 wire 신원을 내부 core 소유권으로 해석한다. 저장·실행에는 가상 플러그인을 만들지 않는다. */
export function normalizeOperationOwner<T extends { readonly pluginId: string | null; readonly type: string }>(operation: T): T {
  return operation.pluginId === "terminal" && operation.type === "agent" ? { ...operation, pluginId: null } : operation;
}
