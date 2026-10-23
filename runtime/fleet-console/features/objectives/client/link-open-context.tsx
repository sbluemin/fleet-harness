import { createContext, useContext } from "react";

import type { OpenLinkHandler } from "@fleet-console/sdk/link";

/**
 * 목표 패널 트리의 링크 열기 길 — 호스트(RailPanelContext·ExpandedSurfaceContext)가
 * 채워 준 `openLink`를 같은 번들의 React 컨텍스트로 나눈다. 번들을 가로지르는
 * 모듈 싱글턴을 쓰지 않으므로 호스트·플러그인 번들이 모듈을 따로 들고 있어도
 * 동작한다. 값이 없으면(모르는 호스트) 앵커 기본 동작으로 떨어진다.
 */
const ObjectiveLinkOpenContext = createContext<OpenLinkHandler | null>(null);

export function ObjectiveLinkOpenProvider({ value, children }: { readonly value: OpenLinkHandler | null; readonly children: React.ReactNode }) {
  return <ObjectiveLinkOpenContext.Provider value={value}>{children}</ObjectiveLinkOpenContext.Provider>;
}

export function useObjectiveLinkOpen(): OpenLinkHandler | null {
  return useContext(ObjectiveLinkOpenContext);
}
