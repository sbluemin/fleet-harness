// op-badge: CREATE(+)/UPDATE(↻) 모두 brass 톤, 글리프+라벨로만 구분 (aurora 단독 금지)
export function renderOpBadge(op: "create_wiki" | "update_wiki", targetExists: boolean): string {
  const isCreate = op === "create_wiki" || !targetExists;
  const glyph = isCreate ? "+" : "↻";
  const label = isCreate ? "CREATE" : "UPDATE";
  const modClass = isCreate ? "op-badge--create" : "op-badge--update";
  return `<span class="op-badge ${modClass}" aria-label="${label}">
    <span class="op-badge-glyph" aria-hidden="true">${glyph}</span>
    <span class="op-badge-label">${label}</span>
  </span>`;
}
