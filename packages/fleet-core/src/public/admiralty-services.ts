import { admiralty as Facade } from "../admiralty/index.js";

export type FleetAdmiraltyServices = typeof Facade;

export function createFleetAdmiraltyServices(): FleetAdmiraltyServices {
  return Facade;
}
