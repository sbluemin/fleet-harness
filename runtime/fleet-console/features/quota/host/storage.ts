import path from "node:path";
import { createDurableJsonStore } from "@fleet-console/infra";

export interface QuotaSettings {
  readonly claudeConnected?: boolean;
}

export interface QuotaSettingsHost {
  read(): Promise<QuotaSettings>;
  write(value: QuotaSettings): Promise<void>;
}

/** 연결 동의만 보존한다. 공급자 정렬·접힘·옛 Cursor 연결 값은 더 이상 저장하지 않는다. */
export function normalizeQuotaSettings(value: unknown): QuotaSettings {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const connected = (value as Record<string, unknown>).claudeConnected;
  return typeof connected === "boolean" ? { claudeConnected: connected } : {};
}

export function createQuotaSettingsStore(dataDir: string, ready: () => boolean = () => true): QuotaSettingsHost {
  const filePath = path.join(dataDir, "quota.json");
  const store = createDurableJsonStore({ filePath, lockDir: `${filePath}.lock`, sensitivity: "sensitive", sanitize: normalizeQuotaSettings });
  return {
    read: async () => store.load(),
    write: async (value) => {
      if (!ready()) throw new Error("quota_migration_pending");
      store.update(() => normalizeQuotaSettings(value));
    },
  };
}
