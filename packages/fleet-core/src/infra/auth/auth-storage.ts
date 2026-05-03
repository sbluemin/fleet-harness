import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthService, AuthStorageData } from "./types.js";

const DEFAULT_AUTH_PATH = path.join(os.homedir(), ".pi", "agent", "auth.json");

let currentAuthPath: string = DEFAULT_AUTH_PATH;

export function createAuthService(): AuthService {
  return {
    async getApiKey(providerId: string): Promise<string | undefined> {
      if (!fs.existsSync(currentAuthPath)) {
        return undefined;
      }

      const data = JSON.parse(fs.readFileSync(currentAuthPath, "utf-8")) as AuthStorageData;
      return typeof data[providerId]?.key === "string" ? data[providerId].key : undefined;
    },

    async setApiKey(providerId: string, key: string): Promise<void> {
      const data = fs.existsSync(currentAuthPath)
        ? JSON.parse(fs.readFileSync(currentAuthPath, "utf-8")) as AuthStorageData
        : {};

      data[providerId] = {
        ...(data[providerId] ?? {}),
        key,
      };

      fs.mkdirSync(path.dirname(currentAuthPath), { recursive: true });
      fs.writeFileSync(currentAuthPath, JSON.stringify(data, null, 2));
    },

    setAuthPath(nextPath: string): void {
      currentAuthPath = nextPath;
    },
  };
}
