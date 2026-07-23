export type TranscriptKind = "message" | "tool" | "stage" | "file" | "unknown";

export interface TranscriptEvent {
  readonly ref: string;
  readonly timestamp?: string;
  readonly kind: TranscriptKind;
  readonly summary: string;
  readonly targetPath?: string;
  readonly stage?: string;
  readonly offset: number;
}

export interface SessionOutline {
  eventCount: number;
  fileTouchCount: number;
  stages: string[];
  readonly truncated: boolean;
  readonly gaps?: readonly { readonly startOffset: number; readonly endOffset: number; readonly skippedBytes: number }[];
}
export interface AnalystArtifact { id: string; title: string; html: string; createdAt: string; }
export type AnalystEvent =
  | { type: "chunk"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool"; title: string; status: string }
  | { type: "artifact"; artifact: AnalystArtifact }
  | { type: "complete" }
  | { type: "error"; error: { code: string; message: string } };

export interface TranscriptIndexerOptions { readonly maxReadBytes?: number; }
export interface SessionToolOptions { readonly capturePath: string; readonly cwd: string; readonly onEvent?: (event: AnalystEvent) => void; }
export interface AnalystSessionOptions extends SessionToolOptions {
  readonly cliId: "claude" | "claude-kimi" | "codex" | "opencode-go" | "cursor";
  readonly model: string;
  readonly effort?: string;
  readonly language?: "en" | "ko";
}
