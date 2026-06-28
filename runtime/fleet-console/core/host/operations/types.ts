import type {
  OperationCreateInput as SdkOperationCreateInput,
  OperationNode as SdkOperationNode,
  OperationPatchInput as SdkOperationPatchInput,
} from "@fleet-console/sdk/operations";

export type { OperationGeometry, OperationTimestamps } from "@fleet-console/sdk/operations";

export interface OperationNode extends SdkOperationNode {
  readonly accent?: string;
}

export interface OperationCreateInput extends SdkOperationCreateInput {
  readonly accent?: string;
}

export interface OperationPatchInput extends SdkOperationPatchInput {
  readonly accent?: string | null;
}

export interface OperationStore {
  list(): readonly OperationNode[];
  listByTheater(theaterId: string): readonly OperationNode[];
  listChildren(theaterId: string, parentId: string | null): readonly OperationNode[];
  get(id: string): OperationNode | null;
  create(input: OperationCreateInput): OperationNode;
  upsert(input: OperationCreateInput): OperationNode;
  patch(id: string, input: OperationPatchInput): OperationNode | null;
  delete(id: string): boolean;
  deleteByTheater(theaterId: string): number;
  replace(nodes: readonly OperationNode[]): void;
}
