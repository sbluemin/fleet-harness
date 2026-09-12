// IME composition 중 Shift+Enter 처리 헬퍼.
//
// 문제: xterm 커스텀 키 핸들러는 keydown 단계에서 호출된다. xterm CompositionHelper는
// compositionend에서 setTimeout(0)으로 최종 한글을 전송하는데, 핸들러가 keydown에서 즉시
// terminal.input("\n")을 호출하면 LF가 최종 한글보다 먼저 들어가 한글이 줄 사이에 분리된다.
//
// 해결: xterm helper textarea의 compositionend 이벤트에서 setTimeout(0)으로 LF를 예약한다.
// 이 리스너는 terminal.open() 이후 등록하므로 xterm의 compositionend 리스너가 먼저 실행돼
// setTimeout(0)을 큐에 넣고, 우리 타이머가 그 뒤에 들어가 FIFO 순서로 한글 뒤에 LF가 붙는다.
// 실제 IME는 compositionend 직후 같은 이벤트 흐름에서 Shift+Enter keydown을 낼 수 있으므로,
// compositionend 후 xterm의 최종 전송 타이머가 도는 한 tick 동안도 composition finalizing 상태로 본다.

export interface ImeShiftEnterHandler {
  readonly onCompositionStart: () => void;
  readonly onCompositionEnd: () => void;
  readonly onCompositionCancel: () => void;
  // attachCustomKeyEventHandler에 그대로 전달한다. false=xterm 기본 동작 차단, true=통과.
  readonly handleKeyEvent: (event: ImeShiftEnterKeyEvent) => boolean;
  // composition 중 pendingLF 타이머를 취소하고 상태를 초기화한다.
  readonly dispose: () => void;
}

export interface ImeShiftEnterKeyEvent {
  readonly code?: string;
  readonly key: string;
  readonly keyCode?: number;
  readonly preventDefault?: () => void;
  readonly shiftKey: boolean;
  readonly type: string;
  readonly which?: number;
  readonly isComposing?: boolean;
}

// sendLF: terminal.input("\n")을 감싼 콜백. 테스트에서는 vi.fn()으로 대체한다.
export function createImeShiftEnterHandler(sendLF: () => void): ImeShiftEnterHandler {
  let isComposing = false;
  let isCompositionFinalizing = false;
  let pendingLF = false;
  let handledShiftEnterKeyDown = false;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let finalizingTimer: ReturnType<typeof setTimeout> | null = null;

  const clearPendingLF = () => {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    pendingLF = false;
  };
  const clearFinalizing = () => {
    if (finalizingTimer !== null) {
      clearTimeout(finalizingTimer);
      finalizingTimer = null;
    }
    isCompositionFinalizing = false;
  };
  const markCompositionFinalizing = () => {
    clearFinalizing();
    isCompositionFinalizing = true;
    finalizingTimer = setTimeout(() => {
      finalizingTimer = null;
      isCompositionFinalizing = false;
    }, 0);
  };
  const schedulePendingLF = () => {
    pendingLF = false;
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    if (finalizingTimer !== null) {
      clearTimeout(finalizingTimer);
      finalizingTimer = null;
    }
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      isCompositionFinalizing = false;
      sendLF();
    }, 0);
  };
  const cancelComposition = () => {
    isComposing = false;
    if (pendingTimer !== null) {
      return;
    }
    clearFinalizing();
    pendingLF = false;
  };
  const dispose = () => {
    isComposing = false;
    handledShiftEnterKeyDown = false;
    clearFinalizing();
    clearPendingLF();
  };
  const handleShiftEnterInput = (event: ImeShiftEnterKeyEvent) => {
    if (pendingTimer !== null) return;
    if (isComposing || isCompositionFinalizing || isImeCompositionKeyEvent(event)) {
      // composition 종료 후 LF를 한 번 전송하도록 예약한다.
      pendingLF = true;
      if (isCompositionFinalizing && !isComposing) {
        schedulePendingLF();
      } else {
        isComposing = true;
      }
      return;
    }
    sendLF();
  };

  return {
    onCompositionStart() {
      isComposing = true;
    },
    onCompositionEnd() {
      isComposing = false;
      markCompositionFinalizing();
      if (!pendingLF) return;
      // xterm의 compositionend setTimeout(0)이 먼저 큐에 들어간 뒤 이 타이머가 뒤따르므로
      // 최종 조합 문자가 터미널에 기록된 다음에 LF가 전송된다.
      schedulePendingLF();
    },
    onCompositionCancel: cancelComposition,
    handleKeyEvent(event) {
      if (isEnterKeyEvent(event) && event.shiftKey) {
        event.preventDefault?.();
        if (event.type === "keydown") {
          handledShiftEnterKeyDown = true;
          handleShiftEnterInput(event);
        } else if (event.type === "keypress") {
          if (!handledShiftEnterKeyDown) handleShiftEnterInput(event);
          handledShiftEnterKeyDown = false;
        } else if (event.type === "keyup") {
          handledShiftEnterKeyDown = false;
        }
        // keydown/keypress 모두 false를 반환해 xterm 기본 CR 전송을 차단한다.
        return false;
      }
      return true;
    },
    dispose,
  };
}

function isEnterKeyEvent(event: ImeShiftEnterKeyEvent): boolean {
  return event.key === "Enter" || event.code === "Enter" || event.keyCode === 13 || event.which === 13;
}

function isImeCompositionKeyEvent(event: ImeShiftEnterKeyEvent): boolean {
  return event.isComposing === true || event.keyCode === 229 || event.which === 229;
}
