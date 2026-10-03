import { parseFileRef, isAbsolute, type FileRef } from "@fleet-console/markdown/file-ref";
import { bindMarkdownLinkActivation } from "@fleet-console/markdown/link-activation";
import type { ClientNavigateCapability } from "@fleet-console/sdk/navigation";
import { fetchFilePeek, fetchFileRefs, CodexRequestError } from "./api.js";
import { getT, resolveActiveLocale } from "../i18n/index.js";
import { escapeHtml } from "./utils.js";

export function codexFileRef(text: string): FileRef | null {
  if (text.startsWith("#") || text.startsWith("/entry/") || text.startsWith("//")) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(text); } catch { return null; }
  const ref = parseFileRef(decoded);
  if (!ref || isAbsolute(ref)) return null;
  // 위키의 상대 링크는 Theater 루트 기준이다. 선행 상위 접두만 걷고 내부 traversal은 거절한다.
  const relative = ref.path.replace(/^(?:(?:\.\.\/)|(?:\.\/))+/u, "");
  if (!relative || relative.split("/").includes("..")) return null;
  return { ...ref, path: relative };
}

export function resolveCodexFileLink(href: string): { kind: string; data: Record<string, string> } | null {
  const ref = codexFileRef(href);
  if (!ref) return null;
  return { kind: "codex-file", data: refData(ref) };
}

function refData(ref: FileRef): Record<string, string> {
  return { path: ref.path, ...(ref.line ? { line: String(ref.line) } : {}), ...(ref.column ? { column: String(ref.column) } : {}) };
}

interface FileLinkOptions {
  readonly container: HTMLElement;
  readonly secondaryContainer?: HTMLElement;
  readonly getTheaterId: () => string | null;
  readonly getNavigate: () => ClientNavigateCapability | undefined;
}

export function mountCodexFileLinks(options: FileLinkOptions) {
  let disposed = false;
  let epoch = 0;
  let peek: HTMLElement | null = null;
  let opener: HTMLElement | null = null;
  const t = () => getT(resolveActiveLocale());
  const closePeek = () => {
    epoch++;
    peek?.remove();
    peek = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    opener = null;
  };

  const openPeek = async (ref: FileRef, target: HTMLElement | null) => {
    const theaterId = options.getTheaterId();
    if (!theaterId) return;
    closePeek();
    const request = ++epoch;
    opener = target;
    const panel = document.createElement("section");
    panel.className = "codex-file-peek";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", t()("codex.files.preview"));
    panel.innerHTML = `<header><strong>${escapeHtml(ref.path)}</strong><button type="button" data-peek-close aria-label="${escapeHtml(t()("common.close"))}">×</button></header><div role="status">${escapeHtml(t()("codex.files.loading"))}</div>`;
    peek = panel;
    if (target && options.container.contains(target)) {
      (target.closest(".cowork-block, p, li, td, blockquote") ?? target).insertAdjacentElement("afterend", panel);
    } else options.container.prepend(panel);
    panel.querySelector<HTMLElement>("[data-peek-close]")?.addEventListener("click", closePeek);
    panel.querySelector<HTMLElement>("[data-peek-close]")?.focus({ preventScroll: true });
    try {
      const result = await fetchFilePeek(theaterId, ref.path, ref.line);
      if (disposed || request !== epoch || options.getTheaterId() !== theaterId) return;
      panel.innerHTML = `<header><strong>${escapeHtml(result.path)}${ref.line ? `:${ref.line}` : ""}</strong><button type="button" data-peek-close aria-label="${escapeHtml(t()("common.close"))}">×</button></header><pre aria-label="${escapeHtml(t()("codex.files.preview"))}">${result.lines.map((text, index) => `<span class="codex-file-peek-line${result.startLine + index === ref.line ? " is-target" : ""}"><span aria-hidden="true">${result.startLine + index}</span><code>${escapeHtml(text) || " "}</code></span>`).join("")}</pre>${result.truncated ? `<p>${escapeHtml(t()("codex.files.truncated"))}</p>` : ""}<footer><button type="button" data-peek-open>${escapeHtml(t()("codex.files.openInFiles"))}</button><span data-peek-error role="alert"></span></footer>`;
      panel.querySelector<HTMLElement>("[data-peek-close]")?.addEventListener("click", closePeek);
      panel.querySelector<HTMLButtonElement>("[data-peek-open]")?.addEventListener("click", async (event) => {
        const button = event.currentTarget as HTMLButtonElement;
        button.disabled = true;
        const status = panel.querySelector<HTMLElement>("[data-peek-error]");
        try {
          const navigate = options.getNavigate();
          const opened = navigate ? await navigate.openFile({ theaterId, path: result.path, pathKind: "theater-relative", line: ref.line, column: ref.column, source: "codex" }) : { ok: false, reason: "no_handler" } as const;
          if (disposed || request !== epoch || options.getTheaterId() !== theaterId) return;
          if (opened.ok) closePeek();
          else if (status) status.textContent = t()(opened.reason === "no_handler" ? "codex.files.noHandler" : "codex.files.openFailed");
        } catch {
          if (!disposed && request === epoch && status) status.textContent = t()("codex.files.openFailed");
        } finally { button.disabled = false; }
      });
      panel.querySelector<HTMLElement>("[data-peek-close]")?.focus({ preventScroll: true });
    } catch (error) {
      if (disposed || request !== epoch || options.getTheaterId() !== theaterId) return;
      const status = panel.querySelector<HTMLElement>("[role=status]");
      if (status) status.textContent = t()(error instanceof CodexRequestError && error.status === 403 ? "codex.files.outside" : "codex.files.unavailable");
    }
  };

  const roots = [options.container, options.secondaryContainer].filter((root): root is HTMLElement => !!root);
  const stopLinks = roots.map(root => bindMarkdownLinkActivation(root, (kind, data, event) => {
    if (kind !== "codex-file") return;
    const ref = codexFileRef(data.path ?? "");
    if (!ref) return;
    const line = Number(data.line), column = Number(data.column);
    void openPeek({ ...ref, ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}), ...(Number.isSafeInteger(column) && column > 0 ? { column } : {}) }, event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("a") : null);
  }));
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !peek || !(event.target instanceof Node) || !peek.contains(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closePeek();
  };
  // 확대 시트의 캡처 Escape보다 먼저 자기 보조 표면을 닫는다.
  window.addEventListener("keydown", onKey, true);

  async function enhanceInlinePaths(body: HTMLElement): Promise<void> {
    const theaterId = options.getTheaterId();
    if (!theaterId) return;
    const candidates = [...body.querySelectorAll<HTMLElement>("code")].filter(code => !code.closest("pre, a, .codex-file-peek") && !code.dataset.codexFileChecked)
      .map(code => ({ code, ref: codexFileRef(code.textContent?.trim() ?? "") }))
      .filter((item): item is { code: HTMLElement; ref: FileRef } => !!item.ref && (item.ref.path.includes("/") || /\.[A-Za-z0-9]+$/u.test(item.ref.path)))
      .slice(0, 200);
    if (!candidates.length) return;
    for (const { code } of candidates) code.dataset.codexFileChecked = "true";
    try {
      const status = await fetchFileRefs(theaterId, [...new Set(candidates.map(({ ref }) => ref.path))]);
      if (disposed || options.getTheaterId() !== theaterId) return;
      for (const { code, ref } of candidates) {
        if (!code.isConnected || !body.contains(code)) continue;
        if (status[ref.path] !== "file") {
          code.classList.add("codex-file-missing");
          code.title = t()("codex.files.unavailable");
          continue;
        }
        const link = document.createElement("a");
        link.href = "#";
        link.dataset.mdLinkKind = "codex-file";
        link.dataset.mdLinkData = JSON.stringify(refData(ref));
        link.setAttribute("role", "link");
        link.tabIndex = 0;
        code.replaceWith(link);
        link.append(code);
      }
    } catch {
      if (!disposed) for (const { code } of candidates) code.classList.add("codex-file-missing");
    }
  }

  return {
    enhanceInlinePaths,
    close: closePeek,
    destroy() { disposed = true; closePeek(); stopLinks.forEach(stop => stop()); window.removeEventListener("keydown", onKey, true); },
  };
}
