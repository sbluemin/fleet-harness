export type CarrierJobKind = "carrier" | "sortie" | "taskforce";

export interface ParsedCarrierJobId {
  kind: CarrierJobKind;
  toolCallId: string;
}

const JOB_PREFIXES = new Set<CarrierJobKind>(["carrier", "sortie", "taskforce"]);

export function buildCarrierJobId(kind: CarrierJobKind, toolCallId: string): string {
  if (!JOB_PREFIXES.has(kind)) {
    throw new Error(`Unsupported carrier job kind: ${kind}`);
  }
  if (!toolCallId.trim()) {
    throw new Error("toolCallId is required.");
  }
  return `${kind}:${toolCallId}`;
}

export function parseCarrierJobId(jobId: string): ParsedCarrierJobId | null {
  const separatorIndex = jobId.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === jobId.length - 1) return null;
  const prefix = jobId.slice(0, separatorIndex);
  if (!JOB_PREFIXES.has(prefix as CarrierJobKind)) return null;
  return {
    kind: prefix as CarrierJobKind,
    toolCallId: jobId.slice(separatorIndex + 1),
  };
}

export function isCarrierJobId(jobId: string): boolean {
  return parseCarrierJobId(jobId) !== null;
}
