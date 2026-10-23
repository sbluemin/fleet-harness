import type { ClientApiCapability } from "@fleet-console/infra/http/client-ports";
import type { ClientSettingsCapability } from "../../settings/shared/client-ports.js";
export interface QuotaClientDeps {
  readonly api: ClientApiCapability;
  readonly settings: ClientSettingsCapability;
}
