import { admiral as Facade } from "../admiral/index.js";

export type FleetAdmiralServices = typeof Facade;

export function createFleetAdmiralServices(): FleetAdmiralServices {
  return Facade;
}
