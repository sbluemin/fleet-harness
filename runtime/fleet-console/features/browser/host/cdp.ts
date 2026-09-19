/**
 * Operation Browser 가 엔진과 말하는 얼굴 — Chrome DevTools Protocol 클라이언트의 최소 계약.
 *
 * 엔진은 창을 든 Fleet Desktop 안의 실제 Chromium 뷰 하나뿐이다(`desktop-engine.ts`). Console 이 Chrome 을
 * 찾거나 띄우는 일은 없다 — 브라우저 기능은 Desktop 앱의 것이고, 다른 클라이언트(브라우저 탭·모바일)에서는
 * 열리지 않는다. 세션 라우팅은 `sessionId` 필드로 실린다(뷰 하나가 세션 하나).
 */

export interface CdpEvent { readonly method: string; readonly params: Record<string, unknown>; readonly sessionId?: string }
export type CdpListener = (event: CdpEvent) => void;

export class CdpError extends Error {
  constructor(readonly method: string, readonly code: number, message: string) { super(`${method}: ${message}`); this.name = "CdpError"; }
}

export interface CdpClient {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
  on(listener: CdpListener): () => void;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}
