import path from "node:path";

import { canonicalizeTheaterPath, theaterLabel, workspaceHash } from "./theater.js";

export interface TheaterRegistration {
  readonly id: string;
  readonly path: string;
  readonly realpath: string;
  readonly label: string;
  readonly registeredAt: string;
  readonly lastOpenedAt: string;
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
    };
    this.#items.set(id, item);
    this.#mruId = id;
    return item;
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
}
