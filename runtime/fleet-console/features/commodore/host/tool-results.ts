export function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: (value && typeof value === "object" && !Array.isArray(value) ? value : { value }) as Record<string, unknown>, isError: false };
}
export function refuse(error: string, extra: Record<string, unknown> = {}) {
  return { ...text({ error, ...extra }), isError: true };
}

/** action별 strict 검증의 거절 — 어느 필드가 어긋났는지(`issues`)를 함께 돌려준다. */
export function parseFail(parsed: { readonly error: string; readonly issues?: unknown }) {
  return refuse(parsed.error, { issues: parsed.issues });
}
