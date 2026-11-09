import type { ChromeRole, ChromeUiState } from "../contract.js";
import { mountBar } from "./bar.js";
import { mountRail } from "./rail.js";
import { post } from "./shared.js";

/**
 * 셸 main 이 문서에 주입하는 프로그램의 입구. 문서는 `<html data-role>` 로 자기 역할을 안다. 상태는 main 이 `__fleetChrome.apply` 로 밀어 넣고,
 * 문서는 사용자의 동작만 `console-message` 로 돌려준다 — 이 문서는 어떤 네트워크도, 어떤 Node API 도 쓰지 않는다.
 */
declare global { interface Window { __fleetChrome?: { apply(state: ChromeUiState): void; inspected(seq: number, element: unknown): void } } }

const role = document.documentElement.dataset.role as ChromeRole | undefined;
if (role === "bar") {
  const bar = mountBar();
  window.__fleetChrome = { apply: bar.render, inspected: bar.inspected };
  post("bar", "ready");
} else if (role === "rail") {
  const render = mountRail();
  window.__fleetChrome = { apply: render, inspected: () => undefined };
  post("rail", "ready");
}
