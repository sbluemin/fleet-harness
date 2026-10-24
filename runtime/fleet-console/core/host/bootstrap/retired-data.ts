import fs from "node:fs";
import path from "node:path";
import { createDurableJsonStore, createStoreCarryOver } from "@fleet-console/infra";
import { normalizeAgentCliPaths } from "../../../features/execution/host/agent/agent-cli-paths.js";
import { normalizeQuotaSettings } from "../../../features/quota/host/storage.js";

/**
 * durable writer만 호출한다. 바로 앞 자리의 동의·CLI 경로를 먼저 승계한 뒤 옛 트리를 회수한다.
 * 읽기·저장에 실패하면 원본 전체를 남겨 다음 기동에 재시도한다. 링크는 승계에도 따라가지 않는다.
 */
export function retireConsoleData(dataDir: string, warn: (message: string) => void = console.warn): boolean {
  const root = path.join(dataDir, "plugins");
  try {
    const rootStat = stat(root);
    if (!rootStat) return true;
    // 루트 링크는 소유한 승계 원천으로 취급하지 않는다. 새 슬롯의 설정 사용은 막지 않는다.
    if (!rootStat.isDirectory()) return true;
    adopt("quota", "settings.json", "quota.json", normalizeQuotaSettings);
    adopt("terminal", "agent-cli-paths.json", "agent-cli-paths.json", normalizeAgentCliPaths);
    // rm은 내부 링크를 따라가지 않는다. 다른 사용자 디렉터리를 가리키는 링크도 링크만 걷힌다.
    try { fs.rmSync(root, { recursive: true, force: true }); }
    catch (error) { warn(`[fleet-console] Retired tree not removed: ${error instanceof Error ? error.message : String(error)}`); }
    return true;
  } catch (error) {
    warn(`[fleet-console] Retired data retained: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }

  function adopt<T>(owner: string, name: string, destinationName: string, sanitize: (value: unknown) => T): void {
    const destination = path.join(dataDir, destinationName);
    const destinationStat = stat(destination);
    if (destinationStat) {
      if (!destinationStat.isFile()) throw new Error("migration_destination_not_file");
      JSON.parse(fs.readFileSync(destination, "utf8"));
      return; // 현재 파일이 유일한 승계 완료 표식이며 옛 값보다 우선한다.
    }
    const parent = path.join(root, owner);
    const parentStat = stat(parent);
    if (!parentStat) return;
    if (!parentStat.isDirectory()) throw new Error("migration_source_not_directory");
    const source = path.join(parent, name);
    const sourceStat = stat(source);
    if (!sourceStat) return;
    if (!sourceStat.isFile()) throw new Error("migration_source_not_file");
    const carry = createStoreCarryOver({
      destinationPath: destination,
      adopted: () => stat(destination)?.isFile() === true,
      sourcePaths: [source],
      adopt: (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("migration_source_invalid");
        return sanitize(value);
      },
    });
    carry.probe();
    // 트리 전체 회수는 개별 파일 승계보다 보수적이다. 손상된 원본도 자동으로 버리지 않는다.
    if (!carry.settled() || carry.carried() === undefined) throw new Error("migration_source_unreadable");
    const store = createDurableJsonStore({ filePath: destination, lockDir: `${destination}.lock`, sensitivity: "sensitive", sanitize });
    const adopted = store.update((current) => carry.pending() ? carry.base(current) : undefined);
    // 저장 후 다시 읽은 정규화 값까지 같아야 회수한다. 실패하면 원본을 보존한다.
    if (!stat(destination)?.isFile()) throw new Error("migration_destination_missing");
    const saved = sanitize(JSON.parse(fs.readFileSync(destination, "utf8")));
    if (JSON.stringify(saved) !== JSON.stringify(adopted)) throw new Error("migration_destination_mismatch");
  }
}

function stat(file: string): fs.Stats | undefined {
  try { return fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
