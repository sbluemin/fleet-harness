import * as React from "react";

import { readLaunchVariantGroups } from "./launch-variants.js";
import type { OperationCatalogPlugin, OperationLaunchKind, OperationLaunchView, OperationNode } from "./types.js";

export interface OperationBodyProps {
  readonly children: React.ReactNode;
  readonly className?: string;
}

const OPERATION_BODY_CLASS = "fc-operation-body";

export class ApiError extends Error {
  readonly status: number;
  /** Parsed JSON error payload when the failing response carried one — lets callers surface route-specific error contracts. */
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export async function fetchOperationCatalog(signal?: AbortSignal): Promise<readonly OperationCatalogPlugin[]> {
  const response = await fetch("/api/v1/operations/catalog", { signal });
  if (!response.ok) throw new ApiError(response.status, `Operation catalog request failed: ${response.status}`);
  const payload = await response.json() as { readonly plugins?: unknown };
  return Array.isArray(payload.plugins) ? payload.plugins.map(readCatalogPlugin).filter((plugin): plugin is OperationCatalogPlugin => plugin !== null) : [];
}

export function assertOperationNode(value: unknown): OperationNode {
  const payload = value as Partial<OperationNode>;
  if (
    !payload
    || typeof payload.id !== "string"
    || typeof payload.theaterId !== "string"
    || typeof payload.type !== "string"
    || typeof payload.pluginId !== "string"
    || typeof payload.title !== "string"
    || !payload.payload
    || typeof payload.payload !== "object"
    || Array.isArray(payload.payload)
    || hasForbiddenBrowserPayloadKey(payload)
  ) {
    throw new ApiError(500, "Invalid operation response");
  }
  return payload as OperationNode;
}

export function hasForbiddenBrowserPayloadKey(value: unknown): boolean {
  return containsForbiddenKey(value, new Set(["canonicalCwd", "cwd", "persona", "prompt", "providerSession", "ticket", "token", "toolAllowlist", "tools", "transcriptPath"]));
}

export function OperationBody({ children, className }: OperationBodyProps): React.ReactElement {
  return <div className={joinClassNames(OPERATION_BODY_CLASS, className)}>{children}</div>;
}

function readCatalogPlugin(value: unknown): OperationCatalogPlugin | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string" || !Array.isArray(value.kinds)) return null;
  const kinds = value.kinds.map(readLaunchKind).filter((kind): kind is OperationLaunchKind => kind !== null);
  if (kinds.length === 0) return null;
  return { id: value.id, title: value.title, kinds };
}

function readLaunchKind(value: unknown): OperationLaunchKind | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.type !== "string" || typeof value.title !== "string") return null;
  const variants = readLaunchVariantGroups(value.variants);
  const launchViews = readLaunchViews(value.launchViews);
  return {
    id: value.id,
    type: value.type,
    title: value.title,
    ...(typeof value.disabled === "boolean" ? { disabled: value.disabled } : {}),
    ...(typeof value.disabledReason === "string" ? { disabledReason: value.disabledReason } : {}),
    ...(variants.length > 0 ? { variants } : {}),
    ...(launchViews.length > 0 ? { launchViews } : {}),
  };
}

/**
 * 모르는 표면 이름은 버린다 — 코어는 자기가 그릴 수 있는 표면만 목록에 올린다. `terminal` 하나만
 * 남는 선언은 선택지가 아니므로 생략과 같게 접는다(호출부가 길이로 판정한다).
 */
function readLaunchViews(value: unknown): readonly OperationLaunchView[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<OperationLaunchView>();
  for (const entry of value) {
    if (entry === "terminal" || entry === "chat") seen.add(entry);
  }
  return seen.has("chat") ? [...seen] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsForbiddenKey(value: unknown, forbidden: ReadonlySet<string>): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsForbiddenKey(item, forbidden));
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => forbidden.has(key) || containsForbiddenKey(item, forbidden));
}

function joinClassNames(...classNames: readonly (string | undefined)[]): string {
  return classNames.filter((className): className is string => Boolean(className)).join(" ");
}
