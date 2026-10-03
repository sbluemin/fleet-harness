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
  /**
   * 실행 중인 프로그램을 포함해 현재 Shell 세션을 끝내고 요청 위치에서 새 Shell을 연다.
   * 파괴적 동작이다 — 호출 쪽은 반드시 사용자의 명시적 확인을 받은 뒤에만 부른다.
   */
  restartAt(request: ShellOpenAtRequest): Promise<ShellOpenAtResult>;
}
