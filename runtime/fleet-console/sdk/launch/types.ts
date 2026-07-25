import type { OperationGeometry, OperationLaunchKind } from "../operations/types.js";
import type { ClientOperationsCapability } from "../plugin/types.js";

export interface LaunchContext {
  readonly theaterId: string;
  readonly kind: OperationLaunchKind;
  readonly geometry: OperationGeometry;
  readonly operations: ClientOperationsCapability;
}
