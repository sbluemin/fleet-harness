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

export type TerminalFontSource = "curated" | "custom";

export interface TerminalFontSettings {
  readonly source: TerminalFontSource;
  readonly id: string | null;
  readonly customName: string;
  readonly family: string;
  readonly size: number;
}

export interface OperationNode {
  readonly id: string;
  readonly theaterId: string;
  readonly parentId: string | null;
  readonly type: string;
  readonly pluginId: string;
  readonly title: string;
  readonly renamedTitle?: string;
  readonly payload: Record<string, unknown>;
  readonly geometry: OperationGeometry | null;
  readonly state: Record<string, unknown>;
  readonly ts: OperationTimestamps;
}

export interface OperationCreateInput {
  readonly id?: string;
  readonly theaterId: string;
  readonly parentId?: string | null;
  readonly type: string;
  readonly pluginId: string;
  readonly title: string;
  readonly payload?: Record<string, unknown>;
  readonly geometry?: OperationGeometry | null;
  readonly state?: Record<string, unknown>;
  readonly createdAt?: number;
}

export interface OperationPatchInput {
  readonly title?: string;
  readonly accent?: string | null;
  readonly parentId?: string | null;
  readonly geometry?: OperationGeometry | null;
  readonly state?: Record<string, unknown>;
  readonly payload?: Record<string, unknown>;
}

export interface OperationLaunchKind {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
}

export interface OperationCatalogPlugin {
  readonly id: string;
  readonly title: string;
  readonly kinds: readonly OperationLaunchKind[];
}

export type OperationLaunchCatalogProvider = () => readonly OperationLaunchKind[] | Promise<readonly OperationLaunchKind[]>;
