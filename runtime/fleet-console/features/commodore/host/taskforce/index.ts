import path from "node:path";

import type { EventPort, HttpPort, HttpSecurityPort } from "@fleet-console/infra/http/host-ports";

import { COMMODORE_CHANNEL, type CommodoreEvent } from "../../shared/contracts/types.js";
import type { TaskforceEvent } from "../../shared/contracts/taskforce.js";
import { createTaskforceRoutes, type TaskforceRoute, type TaskforceRouteHooks } from "./routes.js";
import { createTaskforceStore, type TaskforceStore } from "./store.js";

export type { TaskforceStore } from "./store.js";
export type { TaskforceRoute, TaskforceRouteHooks } from "./routes.js";
export { TaskforceStoreError } from "./errors.js";

export interface TaskforceFeatureDeps {
  readonly consoleDataDir: string;
  readonly events: EventPort;
  readonly http: HttpPort;
  readonly security: HttpSecurityPort;
  /** 아는 사령관인가 — TF 성원 검증이 여기에 기대어 선다. */
  readonly isKnownCommodore?: (commodoreId: string) => boolean;
}

/**
 * TaskForce 호스트 — 사령관 feature가 명시적 의존성 객체로 꽂는 조합이다.
 * 사건은 사령관과 같은 `commodore` 채널로 나가고, TF 내용은 사령관 1:1 기록에
 * 절대 닿지 않는다(저장소가 분리돼 있다).
 */
export function createTaskforceFeature(deps: TaskforceFeatureDeps): {
  readonly store: TaskforceStore;
  readonly routes: readonly TaskforceRoute[];
} {
  const emit = (event: TaskforceEvent | CommodoreEvent) => {
    deps.events.publish(COMMODORE_CHANNEL, event);
  };
  const store = createTaskforceStore({ root: path.join(deps.consoleDataDir, "taskforce"), emit });
  const routes = createTaskforceRoutes(
    { host: { http: deps.http, security: deps.security } },
    store,
    deps.isKnownCommodore ? { isKnownCommodore: deps.isKnownCommodore } : {},
  );
  return { store, routes };
}
