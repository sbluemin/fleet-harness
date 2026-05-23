import * as migrate from "./migrate.js";
import * as paths from "./paths.js";
import { migrateLegacyFleetDataDir } from "./migrate.js";
import { getFleetDataDir } from "./paths.js";

export { migrateLegacyFleetDataDir } from "./migrate.js";
export { getFleetDataDir } from "./paths.js";

export const dataDir = {
  migrate,
  paths,
  getFleetDataDir,
  migrateLegacyFleetDataDir,
};
