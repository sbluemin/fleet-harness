import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AuthService, AuthStorageData } from "./types.js";

export const DEFAULT_AUTH_PATH = path.join(os.homedir(), ".fleet", "auth.json");

let currentAuthPath: string = DEFAULT_AUTH_PATH;

export function createAuthService(): AuthService {
  return {
    async deleteApiKey(providerId: string): Promise<boolean> {
      if (!fs.existsSync(currentAuthPath)) {
        return false;
      }

      const data = readAuthData();
      if (!Object.prototype.hasOwnProperty.call(data, providerId)) {
        return false;
      }

      delete data[providerId];
      fs.writeFileSync(currentAuthPath, JSON.stringify(data, null, 2));
      return true;
    },

    async getApiKey(providerId: string): Promise<string | undefined> {
      if (!fs.existsSync(currentAuthPath)) {
        return undefined;
      }

      const data = readAuthData();
      return typeof data[providerId]?.key === "string" ? data[providerId].key : undefined;
    },

    async listProviderIds(): Promise<string[]> {
      if (!fs.existsSync(currentAuthPath)) {
        return [];
      }

      return Object.keys(readAuthData()).sort();
    },

    async setApiKey(providerId: string, key: string): Promise<void> {
      const data = fs.existsSync(currentAuthPath) ? readAuthData() : {};

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

function readAuthData(): AuthStorageData {
  return JSON.parse(fs.readFileSync(currentAuthPath, "utf-8")) as AuthStorageData;
}
