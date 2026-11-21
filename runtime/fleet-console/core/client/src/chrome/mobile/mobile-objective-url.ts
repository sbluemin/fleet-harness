/**
 * 열린 Objective의 주소 표현(`?op=`). 새로고침해도 보던 대화를 잃지 않게 주소가 들고, 셸은 `popstate`로 읽는다.
 * 대화 목록(홈)은 `?op=`가 없는 홈이다 — 목록과 Objective 화면은 같은 루트라 history 항목을 늘리지 않는다(S-51).
 */
import { consumeMobileReturnDestination, getMobileDestination, setMobileDestination } from "./mobile-store.js";

export function readMobileObjectiveId(): string | null {
  return new URL(window.location.href).searchParams.get("op");
}

export function replaceMobileObjectiveId(objectiveId: string | null): void {
  const url = new URL(window.location.href);
  if (objectiveId) url.searchParams.set("op", objectiveId);
  else url.searchParams.delete("op");
  window.history.replaceState({ ...window.history.state, fleetMobileObjective: false }, "", url);
}

/** 열린 Objective을 접고 직전 문맥(사령관) 또는 대화 목록(홈)으로 돌아간다. 정보 화면이 열려 있었다면 함께 접는다. */
export function closeMobileObjective(restoreContext = true): void {
  const returnTo = restoreContext ? consumeMobileReturnDestination() : null;
  if (returnTo) setMobileDestination(returnTo);
  else if (getMobileDestination().kind === "info") setMobileDestination({ kind: "home" });
  replaceMobileObjectiveId(null);
  window.dispatchEvent(new Event("popstate"));
}
