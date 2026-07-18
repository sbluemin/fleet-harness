export function pathContextKey(theaterId: string | null, relPath: string | null): string {
  return JSON.stringify([theaterId, relPath]);
}
