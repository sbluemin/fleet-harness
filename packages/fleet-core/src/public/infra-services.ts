import { infra as Facade } from "../infra/index.js";

export type FleetInfraServices = typeof Facade;

export function createFleetInfraServices(): FleetInfraServices {
  return Facade;
}
