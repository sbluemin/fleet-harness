export interface OpenFileRequest {
  readonly theaterId: string;
  readonly path: string;
  readonly pathKind: "theater-relative" | "absolute";
  readonly line?: number;
  readonly column?: number;
  readonly source: "palette" | "shell" | "agent-terminal" | "agent-chat" | "codex" | "files" | "other";
}

export interface OpenWikiEntryRequest {
  readonly theaterId: string;
  readonly entryId: string;
}

export type OpenResult = { readonly ok: true } | {
  readonly ok: false;
  readonly reason: "no_handler" | "not_found" | "outside_theater" | "unsupported";
};

export interface ClientNavigateCapability {
  openFile(request: OpenFileRequest): Promise<OpenResult>;
  openWikiEntry(request: OpenWikiEntryRequest): Promise<OpenResult>;
}

export interface ShellOpenAtRequest {
  readonly theaterId: string;
  readonly path?: string;
}

export type ShellOpenAtResult = { readonly ok: true } | {
  readonly ok: false;
  readonly reason: "busy" | "input_pending" | "read_only" | "not_found" | "outside_theater";
};

export interface ClientShellCapability {
  openAt(request: ShellOpenAtRequest): Promise<ShellOpenAtResult>;
}
