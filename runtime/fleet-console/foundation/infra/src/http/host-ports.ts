import type http from "node:http";
export interface ServerOriginPort {
  /**
   * Console이 실제로 리슨 중인 loopback origin. 리슨 확정 전에는 null.
   * 자식 프로세스에 Console 주소를 넘겨야 하는 플러그인이 포트를 추측하지 않도록 한다.
   */
  origin(): string | null;
}


export interface EventPort {
  publish(channel: string, payload: unknown): void;
  subscribe(channel: string, listener: (payload: unknown) => void): () => void;
  registerSseChannel(channel: string): () => void;
}


export interface HttpPort {
  writeJson(res: http.ServerResponse, status: number, payload: unknown): void;
  readJsonBody<T>(req: http.IncomingMessage): Promise<T | null>;
  /**
   * 플러그인이 HTML이나 자산을 직접 쓸 때 얹는 보안 헤더.
   *
   * 목록을 플러그인이 각자 적으면 언젠가 하나가 빠지고, 그 하나가 빠진 응답만
   * 스크립트를 실행할 수 있게 된다. 호스트가 한 벌로 소유한다.
   */
  securityHeaders(extra?: Readonly<Record<string, string>>): Record<string, string>;
}


export interface HttpSecurityPort {
  /**
   * 요청이 도착한 리스너의 Host 경계를 통과했는지 판정한다. 리스너마다 허용 Host가 다르므로
   * 기대 포트는 호스트만 알 수 있다 — 플러그인이 스스로 고른 포트로는 잘못된 경계에 대고
   * 승인할 수 있어 인자로 받지 않는다.
   */
  validateHost(req: http.IncomingMessage): boolean;
  isTerminalAuthorized(req: http.IncomingMessage): boolean;
  isLockAuthorized(req: http.IncomingMessage): boolean;
  /**
   * 이 요청이 열 수 있는 소켓의 등급. 제어를 쥔 원격이 있는 동안 이 기계 앞의 새 터미널은
   * 관전으로만 열린다 — 새로고침이나 패널 재마운트가 조용히 제어를 되가져가면 화면은
   * 여전히 그 기기가 몰고 있다고 말하는데 실제 소유권은 넘어와 버린다.
   *
   * 플러그인이 스스로 판정할 수 없는 값이다. 어느 리스너로 들어왔는지도, 지금 제어를 쥔
   * 세션이 있는지도 Console만 안다.
   */
  resolveTerminalSocketRole(req: http.IncomingMessage): "control" | "viewer";
  /**
   * 이 요청이 쓰기까지 허용되는가.
   *
   * 리스너 신원 자체를 넘기지 않는다 — bind 주소와 포트는 플러그인이 알 필요가 없고,
   * 알면 언젠가 그것으로 자기 경계를 다시 짠다. 판정만 넘긴다: 어느 리스너로 들어왔고
   * 지금 그 리스너가 무엇을 허용하는지는 Console만 안다.
   */
  isWriteAdmitted(req: http.IncomingMessage): boolean;
  /**
   * 이 요청을 받은 리스너가 인정하는 Origin. 허용 집합은 리스너마다 다르므로 호스트가
   * 알려 주고, 대조는 플러그인이 자기 실패 어휘로 한다.
   */
  expectedOrigin(req: http.IncomingMessage): string | null;
}


export interface CleanupPort {
  registerCleanup(cleanup: () => void | Promise<void>): () => void;
}
