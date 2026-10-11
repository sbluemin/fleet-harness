/**
 * 열린 Operation의 주소 표현(`?op=`). 새로고침해도 보던 대화를 잃지 않게 주소가 들고, 셸은 `popstate`로 읽는다.
 * 대화 목록(홈)은 `?op=`가 없는 홈이다 — 목록과 Operation 화면은 같은 루트라 history 항목을 늘리지 않는다(S-51).
 */

export function readMobileOperationId(): string | null {
  return new URL(window.location.href).searchParams.get("op");
}

export function replaceMobileOperationId(operationId: string | null): void {
  const url = new URL(window.location.href);
  if (operationId) url.searchParams.set("op", operationId);
  else url.searchParams.delete("op");
  window.history.replaceState({ ...window.history.state, fleetMobileOperation: false }, "", url);
}

/** 열린 Operation을 접고 대화 목록으로 돌아간다 — 주소의 `?op=`를 거두고 셸이 읽게 알린다. */
export function closeMobileOperation(): void {
  replaceMobileOperationId(null);
  window.dispatchEvent(new Event("popstate"));
}
