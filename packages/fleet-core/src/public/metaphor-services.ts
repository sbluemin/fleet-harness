import { metaphor as Facade } from "../metaphor/index.js";

export type FleetMetaphorServices = typeof Facade;

export function createFleetMetaphorServices(): FleetMetaphorServices {
  return Facade;
}
