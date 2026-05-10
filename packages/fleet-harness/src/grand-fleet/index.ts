import type { ExtensionAPI, ExtensionContext } from "@sbluemin/fleet-coding-agent";
import type { GrandFleetRole } from "@sbluemin/fleet-core/admiralty";

import { infra } from "@sbluemin/fleet-core";
import { getBootConfig } from "../fleet.js";
import registerAdmiralty from "./admiralty/register.js";
import registerFleet from "./fleet/register.js";
import { initGrandFleetState } from "./state.js";

export function registerGrandFleet(ctx: ExtensionContext): void;
export function registerGrandFleet(ctx: ExtensionAPI): void;
export function registerGrandFleet(ctx: ExtensionAPI | ExtensionContext): void {
  const pi = ctx as ExtensionAPI;
  const bootCfg = getBootConfig();
  if (bootCfg && !bootCfg.grandFleet) return;

  const log = infra.log.getLogAPI();
  const role = detectRole();
  if (!role) {
    log.debug("grand-fleet", "PI_GRAND_FLEET_ROLE 미설정 — 단일 함대 모드");
    return;
  }

  log.info("grand-fleet", `역할 감지: ${role}`);
  initGrandFleetState(role);

  if (role === "admiralty") {
    log.info("grand-fleet", "Admiralty 모드 초기화");
    registerAdmiralty(pi);
    return;
  }

  log.info("grand-fleet", `Fleet 모드 초기화 — fleetId=${process.env.FLEET_HARNESS_ID}`);
  registerFleet(pi);
}

export default registerGrandFleet;

function detectRole(): GrandFleetRole | null {
  const roleEnv = process.env.PI_GRAND_FLEET_ROLE;
  if (roleEnv === "admiralty" || roleEnv === "fleet") return roleEnv;
  return null;
}
