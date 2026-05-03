/**
 * 여러 AbortSignal을 하나로 결합합니다.
 * Node 20+에서는 내장 AbortSignal.any()를 사용하고,
 * Node 18에서는 AbortController 기반 폴리필로 동일 의미를 제공합니다.
 */

export function combineAbortSignals(signals: readonly AbortSignal[]): AbortSignal {
  if (signals.length === 0) {
    return new AbortController().signal;
  }

  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([...signals]);
  }

  const abortedSignal = signals.find((signal) => signal.aborted);
  if (abortedSignal) {
    return AbortSignal.abort(abortedSignal.reason);
  }

  const controller = new AbortController();
  const cleanup = new Map<AbortSignal, () => void>();

  const abortFrom = (signal: AbortSignal) => {
    for (const [registeredSignal, listener] of cleanup) {
      registeredSignal.removeEventListener("abort", listener);
    }
    cleanup.clear();
    controller.abort(signal.reason);
  };

  for (const signal of signals) {
    const listener = () => {
      abortFrom(signal);
    };
    cleanup.set(signal, listener);
    signal.addEventListener("abort", listener, { once: true });
  }

  return controller.signal;
}
