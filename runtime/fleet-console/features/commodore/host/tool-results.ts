export function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: (value && typeof value === "object" && !Array.isArray(value) ? value : { value }) as Record<string, unknown>, isError: false };
}
export function refuse(error: string, extra: Record<string, unknown> = {}) {
  return { ...text({ error, ...extra }), isError: true };
}
