import path from "node:path";

import type { WorkspaceMetadata } from "./contracts.js";
import type { TheaterPathResolver } from "./theater-paths.js";

export interface WorkspaceRegistration {
  id: string;
  cwd: string;
  realpath: string;
  label: string;
  registeredAt: string;
  lastOpenedAt: string;
}

export class WorkspaceRegistry {
  readonly #items = new Map<string, WorkspaceRegistration>();
  #mruId: string | null = null;
  readonly #theaterPaths: TheaterPathResolver;

  constructor(theaterPaths: TheaterPathResolver) {
    this.#theaterPaths = theaterPaths;
  }

  async register(cwdInput: string, lastOpenedAt?: string): Promise<WorkspaceRegistration> {
    const cwd = path.resolve(cwdInput);
    const real = await this.#theaterPaths.canonicalize(cwd);
    const id = this.#theaterPaths.hash(real);
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
      registeredAt: existing?.registeredAt ?? now,
      // 복원 경로는 durable lastOpenedAt을 그대로 보존해 재시작 후에도 워크스페이스 최근성
      // 순서(MRU·listRegistrations 동순위 처리)가 durable 상태와 일치하게 한다. 일반 등록은 now.
      lastOpenedAt: lastOpenedAt ?? now,
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

function toMetadata(item: WorkspaceRegistration): WorkspaceMetadata {
  return {
    id: item.id,
    cwd: item.cwd,
    label: item.label,
    registeredAt: item.registeredAt,
    lastOpenedAt: item.lastOpenedAt,
    urlPath: `/console/codex/w/${encodeURIComponent(item.id)}/`,
  };
}
