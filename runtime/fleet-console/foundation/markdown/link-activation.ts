export interface MarkdownLinkTarget {
  readonly kind: string;
  readonly data: Record<string, string>;
}

export type MarkdownLinkActivation = (kind: string, data: Record<string, string>, event: MouseEvent | KeyboardEvent) => void;

export function bindMarkdownLinkActivation(container: HTMLElement, activate: MarkdownLinkActivation): () => void {
  const handle = (event: MouseEvent | KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (event.type === "keydown" && (event as KeyboardEvent).key !== "Enter") return;
    if (event.type === "click" && (event as MouseEvent).button !== 0) return;
    const element = event.target instanceof Element ? event.target : event.target instanceof Node ? event.target.parentElement : null;
    const link = element?.closest<HTMLAnchorElement>("a[data-md-link-kind]");
    if (!link || !container.contains(link)) return;
    event.preventDefault();
    if (event.type === "keydown" && (event as KeyboardEvent).repeat) return;
    const data: Record<string, string> = Object.create(null);
    if (link.dataset.mdLinkData !== undefined) {
      try {
        const parsed: unknown = JSON.parse(link.dataset.mdLinkData);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "string") data[key] = value;
        }
      } catch { return; }
    } else {
      for (const [key, value] of Object.entries(link.dataset)) {
        if (key === "mdLinkKind" || !key.startsWith("md") || value === undefined) continue;
        const name = key.slice(2);
        data[name.charAt(0).toLowerCase() + name.slice(1)] = value;
      }
    }
    activate(link.dataset.mdLinkKind ?? "", data, event);
  };
  container.addEventListener("click", handle);
  container.addEventListener("keydown", handle);
  return () => {
    container.removeEventListener("click", handle);
    container.removeEventListener("keydown", handle);
  };
}
