import { useEffect, useState } from "react";

import { useT } from "../i18n/index.js";
import { reconnectOperationsSseNow } from "../operations-sse.js";

// 재연결이 실패하면 EventSource가 거의 즉시 error를 내므로 connection 상태만으로는
// "다시 연결하는 중"이 사람 눈에 걸리지 않는다(실측: 클릭 250ms 뒤 이미 offline).
// 버튼이 눌렸다는 사실은 상태 기계와 무관하게 이 로컬 pending이 보증한다.
const RECONNECT_FEEDBACK_MS = 800;

export function ReconnectButton() {
  const t = useT();
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!pending) return;
    const handle = setTimeout(() => setPending(false), RECONNECT_FEEDBACK_MS);
    return () => clearTimeout(handle);
  }, [pending]);

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        setPending(true);
        reconnectOperationsSseNow();
      }}
    >
      {t(pending ? "chrome.link.reconnecting" : "chrome.link.reconnect")}
    </button>
  );
}
