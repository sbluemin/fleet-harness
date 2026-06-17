import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

import { dismissOperationToast, focusOperation } from "../store.js";
import type { OperationToast, OperationToastKind } from "../types.js";

interface OperationToastHostProps {
  readonly toasts: readonly OperationToast[];
}

// 상태 라벨 — fleet-harness 해군 메타포. 인디케이터 색(aurora/그린)에 대응한다.
//   sortie launched=캐리어 출격(aurora) · stood down=작업 완료(그린).
const TOAST_STATUS: Record<OperationToastKind, string> = {
  "carrier-call": "Sortie launched",
  ended: "Stood down",
};

const OPERATION_TOAST_TTL_MS = 10_000;

// Theater 무관 전역 Operation 상태 알림 스택. 우하단 고정, 카드별 5초 자동 닫힘.
export function OperationToastHost({ toasts }: OperationToastHostProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="app-toast-host operation-toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <OperationToastCard key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

function OperationToastCard({ toast }: { readonly toast: OperationToast }) {
  const navigate = useNavigate();
  // US-7: 5초 뒤 자동 닫힘.
  useEffect(() => {
    const timer = setTimeout(() => dismissOperationToast(toast.id), OPERATION_TOAST_TTL_MS);
    return () => clearTimeout(timer);
  }, [toast.id]);

  // US-5: 이동 — 해당 Theater로 전환 + Operation 선택 후 Operations로 이동, 토스트 닫기.
  const handleGo = () => {
    focusOperation(toast.sessionId);
    navigate("/operations");
    dismissOperationToast(toast.id);
  };

  return (
    <div className={`app-toast operation-toast operation-toast--${toast.kind}`} role="status">
      <span className="app-toast-dot" aria-hidden="true" />
      {/* US-4: 한 줄, Theater › Operation 순으로 강조하고 상태는 muted eyebrow로 후행 표기 */}
      <span className="operation-toast-text">
        <span className="operation-toast-theater">{toast.theaterLabel}</span>
        <span className="operation-toast-sep" aria-hidden="true">›</span>
        <span className="operation-toast-op">{toast.operationLabel}</span>
        <span className="operation-toast-status">{TOAST_STATUS[toast.kind]}</span>
      </span>
      <div className="operation-toast-actions">
        <button type="button" className="operation-toast-go" onClick={handleGo}>Go</button>
        <button
          type="button"
          className="app-toast-close"
          onClick={() => dismissOperationToast(toast.id)}
          aria-label="Dismiss notification"
        >
          ×
        </button>
      </div>
    </div>
  );
}
