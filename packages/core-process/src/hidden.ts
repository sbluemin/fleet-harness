export function withHidden<T extends object>(options?: T): T & { windowsHide: true } {
  return { ...(options ?? {}), windowsHide: true } as T & { windowsHide: true };
}
