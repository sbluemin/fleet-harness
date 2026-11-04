export interface OpenFileRequest {
  readonly objectiveId?: string;
  readonly theaterId: string;
  /**
   * 파일을 품은 Theater를 소유한 사령관. 출처 문맥(Shell 세션·표면 문맥, 창 params)이
   * 아는 경우에만 싣는다 — Theater에서 주인을 추정하지 않는다. 목표 문맥이면 objectiveId만
   * 보내고, 둘 다 모르면 생략해서 서버가 거절하게 한다.
   */
  readonly commodoreId?: string;
  readonly path: string;
  readonly pathKind: "theater-relative" | "absolute";
  readonly line?: number;
  readonly column?: number;
  readonly source: "palette" | "agent-terminal" | "agent-chat" | "other";
}

export type OpenResult = { readonly ok: true } | {
  readonly ok: false;
  readonly reason: "no_handler" | "not_found" | "outside_theater" | "unsupported";
};

export interface ClientNavigateCapability {
  openFile(request: OpenFileRequest): Promise<OpenResult>;
}
