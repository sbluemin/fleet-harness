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
  readonly pluginId: string;
  readonly title: string;
  readonly payload: Record<string, unknown>;
  readonly geometry: OperationGeometry | null;
  readonly ts: OperationTimestamps;
}

export interface OperationCreateInput {
  readonly id?: string;
  readonly theaterId: string;
  readonly type: string;
  readonly pluginId: string;
  readonly title: string;
  readonly payload?: Record<string, unknown>;
  readonly geometry?: OperationGeometry | null;
  readonly createdAt?: number;
}

export interface OperationPatchInput {
  readonly title?: string;
  readonly accent?: string | null;
  readonly geometry?: OperationGeometry | null;
  readonly payload?: Record<string, unknown>;
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

export interface OperationLaunchKind {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly variants?: readonly OperationLaunchVariantGroup[];
}

export interface OperationCatalogPlugin {
  readonly id: string;
  readonly title: string;
  readonly kinds: readonly OperationLaunchKind[];
}

export type OperationLaunchCatalogProvider = () => readonly OperationLaunchKind[] | Promise<readonly OperationLaunchKind[]>;
