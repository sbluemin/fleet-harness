declare module "virtual:fleet-plugins" {
  import type { FleetClientPlugin } from "@fleet-console/sdk/plugin";

  export const plugins: readonly FleetClientPlugin[];
}
