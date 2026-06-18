import { stat } from "node:fs/promises";
import path from "node:path";

import { resolveMemoryPaths as resolveFleetWikiMemoryPaths } from "@dotobokuri/fleet-wiki";
import type { MemoryPaths } from "@dotobokuri/fleet-wiki";

import type { WorkspaceMetadata } from "./api-types.js";
import { canonicalizeTheaterPath, workspaceHash } from "../theater.js";

export interface WorkspaceRegistration {
  id: string;
  cwd: string;
  realpath: string;
  label: string;
  paths: MemoryPaths;
  registeredAt: string;
  lastOpenedAt: string;
}

export class WorkspaceRegistry {
  readonly #items = new Map<string, WorkspaceRegistration>();
  #mruId: string | null = null;

  async register(cwdInput: string): Promise<WorkspaceRegistration> {
    const cwd = path.resolve(cwdInput);
    const real = await canonicalizeTheaterPath(cwd);
    const paths = resolveFleetWikiMemoryPaths(real);
    if (!(await directoryExists(paths.root))) {
      throw new Error("knowledge_root_missing");
    }
    const id = workspaceHash(real);
    const now = new Date().toISOString();
    const existing = this.#items.get(id);
    if (existing && existing.realpath !== real) {
      throw new Error("workspace_id_collision");
    }
    const item: WorkspaceRegistration = {
      id,
      cwd,
      realpath: real,
      label: path.basename(cwd),
      paths,
      registeredAt: existing?.registeredAt ?? now,
      lastOpenedAt: now,
    };
    this.#items.set(id, item);
    this.#mruId = id;
    return item;
  }

  get(id: string): WorkspaceRegistration | null {
    return this.#items.get(id) ?? null;
  }

  remove(id: string): boolean {
    const deleted = this.#items.delete(id);
    // MRU를 제거하면 다음으로 최근에 열린 남은 워크스페이스를 MRU로 승격한다(없으면 null).
    // null로 비우면 getMru() 기반 라우트(/console/codex, /console/codex/api/...)가 남은
    // Theater 대신 deps.cwd 폴백으로 떨어지므로, TheaterRegistry.remove()와 동일하게 승계한다.
    if (this.#mruId === id) this.#mruId = this.listRegistrations()[0]?.id ?? null;
    return deleted;
  }

  getMru(): WorkspaceRegistration | null {
    return this.#mruId ? this.get(this.#mruId) : null;
  }

  list(): WorkspaceMetadata[] {
    return this.listRegistrations().map(toMetadata);
  }

  listRegistrations(): readonly WorkspaceRegistration[] {
    return [...this.#items.values()]
      .sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt));
  }
}

export function toMetadata(item: WorkspaceRegistration): WorkspaceMetadata {
  return {
    id: item.id,
    cwd: item.cwd,
    label: item.label,
    registeredAt: item.registeredAt,
    lastOpenedAt: item.lastOpenedAt,
    urlPath: `/console/codex/w/${encodeURIComponent(item.id)}/`,
  };
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    return (await stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}
