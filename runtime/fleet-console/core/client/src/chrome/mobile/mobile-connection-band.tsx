import type { ReactNode } from "react";

import { statusGlyphClassName } from "@fleet-console/sdk/components/status-glyph";

import { useT } from "../../i18n/index.js";

/**
 * 연결 띠(S-34, 모바일): 앞 표식 + 한 줄. 재연결 중에는 running 글리프 + 「연결이 끊겼습니다 · 다시 연결하는 중…」이고 동작이 없다.
 * 실패했을 때만 ended 글리프 + 「연결하지 못했습니다」와 오른쪽 「다시 연결」(`children`)이 선다.
 */
export function MobileConnectionBand({ failed, children }: { readonly failed: boolean; readonly children: ReactNode }) {
  const t = useT();
  return (
    <div className="console-link-banner mobile-connection-band" role="status" aria-live="polite">
      <span className={statusGlyphClassName(failed ? "ended" : "running")} aria-hidden="true" />
      <span>{t(failed ? "mobile.band.failed" : "mobile.band.reconnecting")}</span>
      {failed ? children : null}
    </div>
  );
}
