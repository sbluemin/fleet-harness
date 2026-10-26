import fs from "node:fs";
import path from "node:path";
import { workspaceDirectoryNames } from "@fleet-console/infra/workspace-dir";
import type { CommodoreDeletePreview, CommodoreDeleteResult } from "../shared/contracts/deletion.js";
import type { ConsoleCommodoreSummary } from "../shared/contracts/theaters.js";
import { CommodoreStoreError } from "./errors.js";
import type { createCommodoreOwnership } from "./ownership.js";
import type { CommodoreStore } from "./store.js";
import type { CommodoreSupervisor } from "./supervisor.js";

/** 다른 기능의 상태는 조합이 제공한 포트로만 정리한다. */
export interface CommodoreDeletionHost {
  readonly preview: (id: string) => Pick<CommodoreDeletePreview, "objectives" | "runningSessions">;
  readonly stopObjectives: (id: string) => Promise<void>;
  /** 메모리 상태를 거둔 뒤 rename 실패에 쓸 복원 함수를 돌려준다. */
  readonly detachObjectives: (id: string) => { readonly removedObjectives: number; readonly rollback: () => void; readonly committed: () => void };
  readonly cleanup: (id: string) => readonly string[];
  readonly releaseKnowledge: (id: string) => void;
  readonly claudeProjectsDirectory: string;
}

export function createCommodoreDeletion(deps: {
  ownership: ReturnType<typeof createCommodoreOwnership>;
  store: CommodoreStore;
  supervisor: CommodoreSupervisor;
  host: CommodoreDeletionHost;
  consoleDataDir: string;
  summary: (id: string) => ConsoleCommodoreSummary;
  protectedDirectories?: () => readonly string[];
  removed: (id: string, theaterIds: readonly string[]) => void;
}) {
  const confirmationAlias = (id: string, language?: "en" | "ko") => {
    const summary = deps.summary(id);
    return summary.alias || summary.theaters.find((theater) => theater.label)?.label || (language === "ko" ? "사령관" : "Commodore");
  };
  return {
    preview(id: string, language?: "en" | "ko"): CommodoreDeletePreview {
      deps.ownership.assertWritable(id);
      const commodore = deps.summary(id);
      const usage = directorySize(deps.ownership.entities.dirOf(id)!);
      const legacyWarning = deps.ownership.entities.theatersOf(id).some((theater) => workspaceDirectoryNames(theater.path).some((name) =>
        ["objectives", "knowledge"].some((kind) => fs.existsSync(path.join(deps.consoleDataDir, "workspaces", name, kind)))));
      return { commodore, confirmationAlias: confirmationAlias(id, language), ...deps.host.preview(id), activeTurn: commodore.run.phase === "turn", patrol: commodore.active,
        memoryEntries: deps.store.memory.list(id).length, diskBytes: usage.bytes, diskBytesTruncated: usage.truncated, legacyWarning };
    },
    async remove(id: string, alias: string, language?: "en" | "ko"): Promise<CommodoreDeleteResult> {
      // 확인 불일치에는 언어 저장·세션 정지 같은 부수 효과도 없다.
      if (alias !== confirmationAlias(id, language)) throw new CommodoreStoreError("confirmation_mismatch");
      const root = deps.ownership.entities.dirOf(id);
      if (!root) throw new CommodoreStoreError("unknown_commodore");
      const assertProtected = () => {
        if ((deps.protectedDirectories?.() ?? []).some((directory) => {
          const relative = path.relative(root, directory);
          return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
        })) throw new CommodoreStoreError("commodore_contains_theater");
      };
      assertProtected();
      deps.ownership.beginDeletion(id);
      const theaterIds = deps.ownership.theaterIds(id);
      const directory = deps.ownership.entities.dirOf(id)!;
      let committed = false;
      try {
        await deps.supervisor.stopForDeletion(id);
        await deps.host.stopObjectives(id);
        assertProtected();
        const keptDirectories = deps.protectedDirectories?.() ?? [];
        const detached = deps.host.detachObjectives(id);
        let staging: string;
        try { staging = deps.ownership.entities.remove(id); }
        catch (error) { detached.rollback(); throw error; }
        committed = true;
        deps.store.forget(id);
        const warnings: string[] = [];
        const bestEffort = (code: string, run: () => void) => {
          try { run(); } catch { warnings.push(code); console.warn(`[commodore] deletion ${id}: ${code}`); }
        };
        bestEffort("objective_cleanup_failed", detached.committed);
        // rename이 커밋점이다. 정리 실패도 응답에 싣고, 중단된 rm은 다음 기동이 재시도한다.
        try { await fs.promises.rm(staging, { recursive: true, force: true }); }
        catch { warnings.push("directory_cleanup_failed"); console.warn(`[commodore] deletion ${id}: directory_cleanup_failed`); }
        bestEffort("settings_cleanup_failed", () => { warnings.push(...deps.host.cleanup(id)); });
        bestEffort("claude_history_cleanup_failed", () => removeClaudeHistory(deps.host.claudeProjectsDirectory, directory, keptDirectories));
        bestEffort("knowledge_cleanup_failed", () => deps.host.releaseKnowledge(id));
        deps.removed(id, theaterIds);
        return { deleted: id, removedObjectives: detached.removedObjectives, warnings };
      } finally {
        deps.ownership.endDeletion(id);
        // legacy 복구는 호출하지 않는다. 삭제 직후 새 UUID를 발급해서는 안 된다.
        if (committed) deps.supervisor.sync();
      }
    },
  };
}

/** 링크를 따라가지 않고 한 요청의 파일 수·시간을 제한한다. 부분 합계는 명시한다. */
function directorySize(root: string): { bytes: number; truncated: boolean } {
  let bytes = 0, visited = 0;
  const until = Date.now() + 100;
  const pending = [root];
  while (pending.length) {
    if (++visited > 50_000 || Date.now() > until) return { bytes, truncated: true };
    const file = pending.pop()!;
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) pending.push(...fs.readdirSync(file).map((name) => path.join(file, name)));
      else if (stat.isFile()) bytes += stat.size;
    } catch { return { bytes, truncated: true }; }
  }
  return { bytes, truncated: false };
}

/** UUID까지 포함한 정확한 cwd 인코딩 경계만 지운다. Theater 기록·다른 홈 링크는 보존한다. */
function removeClaudeHistory(projects: string, directory: string, keptDirectories: readonly string[]): void {
  if (!fs.existsSync(projects)) return;
  if (fs.lstatSync(projects).isSymbolicLink()) throw new Error("unsafe_claude_projects");
  const base = fs.realpathSync.native(projects);
  const prefix = directory.replace(/[^a-zA-Z0-9]/g, "-");
  const kept = new Set(keptDirectories.map((root) => root.replace(/[^a-zA-Z0-9]/g, "-")));
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (kept.has(entry.name) || (entry.name !== prefix && !entry.name.startsWith(`${prefix}-`))) continue;
    const candidate = path.join(base, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink() || fs.realpathSync.native(candidate) !== candidate || path.dirname(candidate) !== base) continue;
    fs.rmSync(candidate, { recursive: true, force: true });
  }
}
