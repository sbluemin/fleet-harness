import { DESKTOP_BROWSER_OWNER_HEADER, type DesktopBrowserAccessPath } from "@fleet-console/protocol/desktop";

/**
 * 이 Desktop 이 관리하고 정체를 확인한 콘솔 하나. 브라우저 엔진은 이 연결로만 붙고, 토큰은 그 콘솔의 루프백 요청에만 실린다.
 */
export interface ManagedBrowserConnection {
  readonly key: string;
  readonly origin: string;
  readonly token: string;
  readonly ownerId: string;
  readonly accessPath: DesktopBrowserAccessPath;
}

/** 락 토큰과 소유자 헤더. 원격·비관리 콘솔에는 붙이지 않는다. */
export function managedBrowserHeaders(connection: ManagedBrowserConnection): Record<string, string> {
  return {
    Authorization: `Bearer ${connection.token}`,
    [DESKTOP_BROWSER_OWNER_HEADER]: connection.ownerId,
  };
}

/**
 * `PUT /api/v1/desktop/shell` 헤더. 증명이 이 origin 의 매니지드 콘솔일 때만 자격을 싣는다.
 * origin 이 다르면 헤더를 빼서 다른 콘솔로 토큰이 나가지 않게 한다.
 */
export function shellPublishHeaders(origin: string, managed: ManagedBrowserConnection | null): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: origin };
  if (managed !== null && managed.origin === origin) Object.assign(headers, managedBrowserHeaders(managed));
  return headers;
}
