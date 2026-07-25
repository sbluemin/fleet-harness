import type {
  OperationCreateInput as SdkOperationCreateInput,
  OperationNode as SdkOperationNode,
  OperationPatchInput as SdkOperationPatchInput,
} from "@fleet-console/sdk/operations";

export type { OperationGeometry, OperationTimestamps } from "@fleet-console/sdk/operations";

export interface OperationGroup {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly order: number;
  readonly theaterId: string;
  readonly createdAt: number;
}

export interface OperationGroupCreateInput {
  readonly id?: string;
  readonly name: string;
  readonly color: string;
  readonly order?: number;
  readonly theaterId: string;
}

export interface OperationGroupPatchInput {
  readonly name?: string;
  readonly color?: string;
  readonly order?: number;
}

export interface OperationNode extends SdkOperationNode {
  readonly accent?: string;
  readonly groupId?: string | null;
}

export interface OperationCreateInput extends SdkOperationCreateInput {
  readonly accent?: string;
  readonly groupId?: string | null;
}

export interface OperationPatchInput extends SdkOperationPatchInput {
  readonly accent?: string | null;
  readonly groupId?: string | null;
}

export interface OperationStore {
  list(): readonly OperationNode[];
  listByTheater(theaterId: string): readonly OperationNode[];
  get(id: string): OperationNode | null;
  create(input: OperationCreateInput): OperationNode;
  upsert(input: OperationCreateInput): OperationNode;
  patch(id: string, input: OperationPatchInput): OperationNode | null;
  delete(id: string): boolean;
  deleteByTheater(theaterId: string): number;
  replace(nodes: readonly OperationNode[]): void;
  createGroup(input: OperationGroupCreateInput): OperationGroup;
  updateGroup(id: string, input: OperationGroupPatchInput): OperationGroup | null;
  deleteGroup(id: string): boolean;
  listGroups(theaterId: string): readonly OperationGroup[];
  listAllGroups(): readonly OperationGroup[];
  deleteGroupsByTheater(theaterId: string): number;
  replaceGroups(groups: readonly OperationGroup[]): void;
}

// 그룹 이름 최대 길이 — durable sanitize(영속 검증)와 store(생성/수정) 양쪽이 공유하는 단일 제한.
export const MAX_GROUP_NAME_LENGTH = 64;
export const DELETION_GRACE_MS = 8000;
