import path from "node:path";

import { canonicalizeTheaterPath, theaterLabel, workspaceHash } from "./theater.js";

export interface TheaterRegistration {
  readonly id: string;
  readonly path: string;
  readonly realpath: string;
  readonly label: string;
  readonly registeredAt: string;
  readonly lastOpenedAt: string;
  readonly pathContext: string | null;
}

export class TheaterRegistry {
  readonly #items = new Map<string, TheaterRegistration>();
  #mruId: string | null = null;

  async register(cwd: string): Promise<TheaterRegistration> {
    const resolved = path.resolve(cwd);
    const real = await canonicalizeTheaterPath(resolved);
    const id = workspaceHash(real);
    const now = new Date().toISOString();
    const existing = this.#items.get(id);
    if (existing && existing.realpath !== real) {
      throw new Error("theater_id_collision");
    }
    const item: TheaterRegistration = {
      id,
      path: resolved,
      realpath: real,
      label: theaterLabel(resolved),
      registeredAt: existing?.registeredAt ?? now,
      lastOpenedAt: now,
      pathContext: existing?.pathContext ?? null,
    };
    this.#items.set(id, item);
    this.#mruId = id;
    return item;
  }

  load(items: readonly TheaterRegistration[]): void {
    this.restore(items);
  }

  restore(items: readonly TheaterRegistration[]): void {
    const restored = new Map<string, TheaterRegistration>();
    let mruId: string | null = null;
    for (const item of items) {
      const existing = restored.get(item.id);
      if (existing && existing.realpath !== item.realpath) {
        throw new Error("theater_id_collision");
      }
      restored.set(item.id, item);
      if (!mruId || item.lastOpenedAt.localeCompare(restored.get(mruId)?.lastOpenedAt ?? "") > 0) {
        mruId = item.id;
      }
    }
    this.#items.clear();
    for (const [id, item] of restored) this.#items.set(id, item);
    this.#mruId = mruId;
  }

  get(id: string): TheaterRegistration | null {
    return this.#items.get(id) ?? null;
  }

  getMru(): TheaterRegistration | null {
    return this.#mruId ? this.get(this.#mruId) : null;
  }

  list(): readonly TheaterRegistration[] {
    return [...this.#items.values()].sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt));
  }

  remove(id: string): boolean {
    const removed = this.#items.delete(id);
    if (this.#mruId === id) this.#mruId = this.list()[0]?.id ?? null;
    return removed;
  }

  setPathContext(id: string, pathContext: string | null): TheaterRegistration | null {
    const current = this.#items.get(id);
    if (!current) return null;
    const next = { ...current, pathContext };
    this.#items.set(id, next);
    return next;
  }
}
