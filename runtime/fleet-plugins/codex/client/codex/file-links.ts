import { parseFileRef, isAbsolute, type FileRef } from "@fleet-console/markdown/file-ref";
import { bindMarkdownLinkActivation } from "@fleet-console/markdown/link-activation";
import type { ClientNavigateCapability } from "@fleet-console/sdk/navigation";
import { fetchFilePeek, fetchFileRefs, CodexRequestError } from "./api.js";
import { getT, resolveActiveLocale } from "../i18n/index.js";
import { escapeHtml } from "./utils.js";

export function codexFileRef(text: string, allowAbsolute = false): FileRef | null {
  if (text.startsWith("#") || text.startsWith("/entry/") || text.startsWith("//")) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(text); } catch { return null; }
  const ref = parseFileRef(decoded);
  if (!ref) return null;
  if (isAbsolute(ref)) return allowAbsolute ? ref : null;
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

function peekPathLabel(ref: FileRef): string {
  const label = escapeHtml(`${ref.path}${ref.line ? `:${ref.line}` : ""}`);
  return `<strong title="${label}"><bdi dir="ltr">${label}</bdi></strong>`;
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
  let navigationError: HTMLElement | null = null;
  let opener: HTMLElement | null = null;
  const t = () => getT(resolveActiveLocale());
  const closePeek = () => {
    epoch++;
    peek?.remove();
    peek = null;
    navigationError?.remove();
    navigationError = null;
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
    panel.innerHTML = `<header>${peekPathLabel(ref)}<button type="button" data-peek-close aria-label="${escapeHtml(t()("common.close"))}">×</button></header><div role="status">${escapeHtml(t()("codex.files.loading"))}</div>`;
    peek = panel;
    if (target && options.container.contains(target)) {
      (target.closest(".cowork-block, p, li, td, blockquote") ?? target).insertAdjacentElement("afterend", panel);
    } else options.container.prepend(panel);
    panel.querySelector<HTMLElement>("[data-peek-close]")?.addEventListener("click", closePeek);
    panel.querySelector<HTMLElement>("[data-peek-close]")?.focus({ preventScroll: true });
    try {
      const result = await fetchFilePeek(theaterId, ref.path, ref.line);
      if (disposed || request !== epoch || options.getTheaterId() !== theaterId) return;
      panel.innerHTML = `<header>${peekPathLabel({ ...ref, path: result.path })}<div class="codex-file-peek-actions"><button type="button" data-peek-open>${escapeHtml(t()("codex.files.openInFiles"))}</button><button type="button" data-peek-close aria-label="${escapeHtml(t()("common.close"))}">×</button></div></header><pre aria-label="${escapeHtml(t()("codex.files.preview"))}">${result.lines.map((text, index) => `<span class="codex-file-peek-line${result.startLine + index === ref.line ? " is-target" : ""}"><span aria-hidden="true">${result.startLine + index}</span><code>${escapeHtml(text) || " "}</code></span>`).join("")}</pre>${result.truncated ? `<p>${escapeHtml(t()("codex.files.truncated"))}</p>` : ""}<span data-peek-error role="alert"></span>`;
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
      const pre = panel.querySelector("pre");
      const selected = panel.querySelector<HTMLElement>(".codex-file-peek-line.is-target");
      if (pre && selected) {
        const row = selected.getBoundingClientRect();
        pre.scrollTop += row.top - pre.getBoundingClientRect().top - (pre.clientHeight - row.height) / 2;
      }
      panel.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch (error) {
      if (disposed || request !== epoch || options.getTheaterId() !== theaterId) return;
      const status = panel.querySelector<HTMLElement>("[role=status]");
      if (status) status.textContent = t()(error instanceof CodexRequestError && error.code === "forbidden" ? "codex.files.forbidden" : error instanceof CodexRequestError && error.status === 403 ? "codex.files.outside" : "codex.files.unavailable");
      panel.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  };

  const openDirectory = async (ref: FileRef, target: HTMLElement | null) => {
    const theaterId = options.getTheaterId();
    if (!theaterId) return;
    closePeek();
    const request = ++epoch;
    let message: "codex.files.noHandler" | "codex.files.openFailed";
    try {
      const navigate = options.getNavigate();
      const opened = navigate ? await navigate.openFile({ theaterId, path: ref.path, pathKind: "theater-relative", source: "codex" }) : { ok: false, reason: "no_handler" } as const;
      if (opened.ok) return;
      message = opened.reason === "no_handler" ? "codex.files.noHandler" : "codex.files.openFailed";
    } catch { message = "codex.files.openFailed"; }
    if (disposed || request !== epoch || options.getTheaterId() !== theaterId) return;
    const status = document.createElement("p");
    status.setAttribute("role", "alert");
    status.textContent = t()(message);
    navigationError = status;
    if (target && options.container.contains(target)) (target.closest("p, li, td, blockquote") ?? target).insertAdjacentElement("afterend", status);
    else options.container.prepend(status);
  };

  const roots = [options.container, options.secondaryContainer].filter((root): root is HTMLElement => !!root);
  const stopLinks = roots.map(root => bindMarkdownLinkActivation(root, (kind, data, event) => {
    if (kind !== "codex-file") return;
    const ref = data.status === "dir" && data.path === "." ? { path: "." } : codexFileRef(data.path ?? "");
    if (!ref) return;
    const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("a") : null;
    if (data.status === "dir") {
      void openDirectory(ref, target);
      return;
    }
    const line = Number(data.line), column = Number(data.column);
    void openPeek({ ...ref, ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}), ...(Number.isSafeInteger(column) && column > 0 ? { column } : {}) }, target);
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
      .map(code => ({ code, ref: codexFileRef(code.textContent?.trim() ?? "", true) }))
      .filter((item): item is { code: HTMLElement; ref: FileRef } => !!item.ref && (item.ref.path.includes("/") || /\.[A-Za-z0-9]+$/u.test(item.ref.path)))
      .slice(0, 200);
    if (!candidates.length) return;
    for (const { code } of candidates) code.dataset.codexFileChecked = "true";
    try {
      const paths = [...new Set(candidates.map(({ ref }) => ref.path))];
      const refs = await fetchFileRefs(theaterId, paths);
      if (disposed || options.getTheaterId() !== theaterId) return;
      // 절대 입력을 응답에 반사하지 않고 요청 순서로 원래 코드와 상대 경로를 대응시킨다.
      const resolved = new Map(paths.map((path, index) => [path, refs[index]]));
      for (const { code, ref } of candidates) {
        if (!code.isConnected || !body.contains(code)) continue;
        const result = resolved.get(ref.path);
        if (!result || result.status === "unavailable") continue;
        if (result.status === "missing") {
          code.classList.add("codex-file-missing");
          code.title = t()("codex.files.unavailable");
          continue;
        }
        const link = document.createElement("a");
        link.href = "#";
        link.dataset.mdLinkKind = "codex-file";
        link.dataset.mdLinkData = JSON.stringify({ ...refData({ ...ref, path: result.path }), status: result.status });
        link.setAttribute("role", "link");
        link.tabIndex = 0;
        code.replaceWith(link);
        link.append(code);
      }
    } catch {
      // 거절/일시 오류는 존재 여부를 말하지 않는다. missing 응답만 흐리게 표시한다.
      if (!disposed) for (const { code } of candidates) delete code.dataset.codexFileChecked;
    }
  }

  return {
    enhanceInlinePaths,
    close: closePeek,
    destroy() { disposed = true; closePeek(); stopLinks.forEach(stop => stop()); window.removeEventListener("keydown", onKey, true); },
  };
}
