declare module "virtual:fleet-plugins" {
  import type { NotificationKindDescriptor } from "@fleet-console/sdk/notifications";
  import type { OperationKindDescriptor } from "@fleet-console/sdk/plugin";
  import type { FleetClientPlugin, SettingsSectionDescriptor } from "@fleet-console/sdk/plugin";

  export const plugins: readonly FleetClientPlugin[];
  export const operationKinds: readonly OperationKindDescriptor[];
  export const settingsSections: readonly SettingsSectionDescriptor[];
  export const notificationKinds: readonly NotificationKindDescriptor[];
}
