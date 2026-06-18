import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

import { dismissOperationToast, focusOperation } from "../store.js";
import type { OperationToast, OperationToastKind } from "../types.js";

interface OperationToastHostProps {
  readonly toasts: readonly OperationToast[];
}

// 상태 라벨 — fleet-harness 해군 메타포. 인디케이터 색(aurora/그린/amber)에 대응한다.
//   sortie launched=캐리어 출격(aurora) · stood down=작업 완료(그린) · awaiting orders=입력 대기(amber).
const TOAST_STATUS: Record<OperationToastKind, string> = {
  "carrier-call": "Sortie launched",
  ended: "Stood down",
  "input-waiting": "Awaiting orders",
};

const OPERATION_TOAST_TTL_MS = 10_000;

// Theater 무관 전역 Operation 상태 알림 스택. 상단 중앙 고정, 카드별 자동 닫힘(단 '완료' 상태는 계속 표시).
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
  // US-7: 자동 닫힘 — 단, '완료'(ended)·'입력 대기'(input-waiting)는 시간제한 없이 계속 표시하고
  // 클릭 이동 또는 수동 닫기로만 사라진다(자리를 비웠다 돌아와도 보이도록).
  useEffect(() => {
    if (toast.kind === "ended" || toast.kind === "input-waiting") return;
    const timer = setTimeout(() => dismissOperationToast(toast.id), OPERATION_TOAST_TTL_MS);
    return () => clearTimeout(timer);
  }, [toast.id, toast.kind]);

  // US-5: 이동 — 해당 Theater로 전환 + Operation 선택 후 Operations로 이동, 토스트 닫기.
  const handleGo = () => {
    focusOperation(toast.sessionId);
    navigate("/operations");
    dismissOperationToast(toast.id);
  };

  return (
    <div className={`app-toast operation-toast operation-toast--${toast.kind}`} role="status">
      {/* 토스트 본문 선택 = 이동(Go). 닫기 버튼과 중첩되지 않도록 형제 버튼으로 분리한다. */}
      <button
        type="button"
        className="operation-toast-go-surface"
        onClick={handleGo}
        aria-label={`${toast.theaterLabel} › ${toast.operationLabel} — ${TOAST_STATUS[toast.kind]}. 선택하여 이동`}
      >
        <span className="app-toast-dot" aria-hidden="true" />
        {/* US-4: 한 줄, Theater › Operation 순으로 강조하고 상태는 muted eyebrow로 후행 표기 */}
        <span className="operation-toast-text">
          <span className="operation-toast-theater">{toast.theaterLabel}</span>
          <span className="operation-toast-sep" aria-hidden="true">›</span>
          <span className="operation-toast-op">{toast.operationLabel}</span>
          <span className="operation-toast-status">{TOAST_STATUS[toast.kind]}</span>
        </span>
      </button>
      <button
        type="button"
        className="app-toast-close"
        onClick={() => dismissOperationToast(toast.id)}
        aria-label="Dismiss notification"
      >
        ×
      </button>
    </div>
  );
}
