import type { ReactNode } from "react";

import { useT } from "../../i18n/index.js";

/**
 * 연결 띠(S-34, 모바일): 한 줄. 재연결 중에는 「연결이 끊겼습니다 · 다시 연결하는 중…」이고 동작이 없다.
 * 실패했을 때만 「연결하지 못했습니다」와 오른쪽 「다시 연결」(`children`)이 선다. 주체(Operation·Theater)가 없는 상태라 아바타를 세우지 않고 글이 말한다.
 */
export function MobileConnectionBand({ failed, children }: { readonly failed: boolean; readonly children: ReactNode }) {
  const t = useT();
  return (
    <div className="console-link-banner mobile-connection-band" role="status" aria-live="polite">
      <span>{t(failed ? "mobile.band.failed" : "mobile.band.reconnecting")}</span>
      {failed ? children : null}
    </div>
  );
}
