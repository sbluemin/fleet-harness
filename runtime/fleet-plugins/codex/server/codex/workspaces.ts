/** 열린 Codex workspace 하나 — 정체성은 사령관 id이고 root는 호스트가 그 id로 정한다. */
export interface WorkspaceRegistration {
  id: string;
  registeredAt: string;
  lastOpenedAt: string;
}

export class WorkspaceRegistry {
  readonly #items = new Map<string, WorkspaceRegistration>();
  #mruId: string | null = null;

  register(id: string): WorkspaceRegistration {
    const now = new Date().toISOString();
    const existing = this.#items.get(id);
    const item: WorkspaceRegistration = { id, registeredAt: existing?.registeredAt ?? now, lastOpenedAt: now };
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
    if (this.#mruId === id) this.#mruId = this.listRegistrations()[0]?.id ?? null;
    return deleted;
  }

  getMru(): WorkspaceRegistration | null {
    return this.#mruId ? this.get(this.#mruId) : null;
  }

  listRegistrations(): readonly WorkspaceRegistration[] {
    return [...this.#items.values()]
      .sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt));
  }
}
