import * as os from "node:os";
import * as path from "node:path";

const FLEET_DATA_DIR_NAME = ".fleet";

export function getFleetDataDir(): string {
  return path.join(os.homedir(), FLEET_DATA_DIR_NAME);
}
