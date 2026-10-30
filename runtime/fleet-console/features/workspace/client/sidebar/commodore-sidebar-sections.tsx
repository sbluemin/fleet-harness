import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronGlyph } from "@fleet-console/ui/react";
import { useT } from "../../../../core/client/src/i18n/index.js";
import { refreshCommodoreList, replaceCommodoreList, replaceCommodoreSidebarLayout, useCommodoreSidebarLayout } from "../../../commodore/client/commodore-list.js";
import { updateCommodoreSidebar } from "../../../commodore/client/theaters-api.js";
import { MAX_SIDEBAR_SECTION_NAME, type CommodoreSidebarCommand, type CommodoreSidebarSection } from "../../../commodore/shared/contracts/sidebar-layout.js";
import { useLongPress } from "../long-press.js";
import { useContextMenuKeyboard } from "./context-menu-keyboard.js";
import { anchorElementAt, scrollMovesAnchor } from "../anchored-scroll-dismissal.js";
import "./commodore-sidebar-sections.css";

export function useCommodoreSidebarSections() {
  const layout = useCommodoreSidebarLayout();
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const t = useT();
  const run = useCallback(async (command: CommodoreSidebarCommand) => {
    if (pending.current) return null;
    pending.current = true; setBusy(true); setError(false);
    try {
      const result = await updateCommodoreSidebar(command);
      replaceCommodoreList(result.commodores);
      if (result.sidebarLayout) replaceCommodoreSidebarLayout(result.sidebarLayout);
      return result;
    } catch { setError(true); return null; }
    finally {
      pending.current = false; setBusy(false);
      // 변경과 겹친 SSE 조회가 오래된 응답을 돌려줘도 마지막 조회로 합류한다.
      void refreshCommodoreList();
    }
  }, []);
  const create = async (input: { commodoreId?: string; afterId?: string }) => {
    const result = await run({ op: "create", name: t("sidebar.commodoreSection.defaultName"), ...input });
    if (result?.createdSectionId) setEditing(result.createdSectionId);
  };
  return { layout, editing, setEditing, error, busy, run, create };
}
export type SidebarSectionsController = ReturnType<typeof useCommodoreSidebarSections>;

export function CommodoreSidebarSection({ id, controller, count, children, dropTarget }: {
  readonly id: string | null;
  readonly controller: SidebarSectionsController;
  readonly count: number;
  readonly children: ReactNode;
  readonly dropTarget: boolean;
}) {
  const t = useT();
  const section = controller.layout.sections.find((row) => row.id === id);
  const name = section?.name ?? t("sidebar.commodoreSection.none");
  const collapsed = section?.collapsed ?? controller.layout.unsectionedCollapsed;
  const header = useRef<HTMLButtonElement>(null);
  const restoreNameFocus = useRef(false);
  useLayoutEffect(() => {
    if (restoreNameFocus.current && controller.editing !== id && !controller.busy) {
      restoreNameFocus.current = false;
      header.current?.focus({ preventScroll: true });
    }
  }, [controller.editing, controller.busy, id]);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [deleting, setDeleting] = useState(false);
  const openMenu = (anchor: DOMRect) => { if (section) setMenu(anchor); };
  const longPress = useLongPress<HTMLButtonElement>((element) => openMenu(element.getBoundingClientRect()));
  const closeMenu = () => { setMenu(null); header.current?.focus({ preventScroll: true }); };
  const index = controller.layout.sections.findIndex((row) => row.id === id);
  const action = (command: CommodoreSidebarCommand) => { closeMenu(); void controller.run(command); };
  return <li className={`workspace-commodore-section${dropTarget ? " is-drop-target" : ""}`} data-sidebar-section={id ?? ""}>
    {section && controller.editing === id ? <SectionNameInput name={name} onDone={(value, viaKey) => {
      restoreNameFocus.current = viaKey;
      controller.setEditing(null);
      if (value && value !== name) void controller.run({ op: "rename", sectionId: section.id, name: value });
    }} /> : <button ref={header} type="button" className="workspace-commodore-section-head" data-sidebar-section-drop={id ?? ""}
      data-keep-objective-active="" aria-expanded={!collapsed} aria-disabled={controller.busy} title={name}
      onClick={() => { void controller.run({ op: "collapse", sectionId: id, collapsed: !collapsed }); }}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); if (!longPress.claimContextMenu(event)) openMenu(new DOMRect(event.clientX, event.clientY, 0, 0)); }}
      onPointerDown={longPress.onPointerDown} onPointerMove={longPress.onPointerMove} onPointerUp={longPress.onPointerUp} onPointerCancel={longPress.onPointerCancel}
      onKeyDown={(event) => {
        if (section && event.key === "F2") { event.preventDefault(); controller.setEditing(section.id); }
        if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") { event.preventDefault(); openMenu(event.currentTarget.getBoundingClientRect()); }
      }}>
      <span className="workspace-commodore-section-label">{name}</span>
      {collapsed ? <span className="workspace-commodore-section-count">{count}</span> : null}
      <ChevronGlyph direction={collapsed ? "right" : "down"} className="workspace-commodore-section-chevron" />
    </button>}
    {!collapsed ? <ol className="workspace-commodore-section-rows">
      {count ? children : <li className="workspace-commodore-section-empty" data-sidebar-section-drop={id ?? ""}>{t("sidebar.commodoreSection.empty")}</li>}
    </ol> : null}
    {menu && section ? <SectionMenu anchor={menu} opener={header.current} label={t("sidebar.commodoreSection.actions", { name })} onClose={closeMenu}>
      <MenuItem onClick={() => { closeMenu(); controller.setEditing(section.id); }}>{t("sidebar.commodoreSection.rename")}</MenuItem>
      <MenuItem disabled={index === 0 || controller.busy} onClick={() => action({ op: "reorder", sectionId: section.id, direction: "up" })}>{t("sidebar.commodoreSection.up")}</MenuItem>
      <MenuItem disabled={index === controller.layout.sections.length - 1 || controller.busy} onClick={() => action({ op: "reorder", sectionId: section.id, direction: "down" })}>{t("sidebar.commodoreSection.down")}</MenuItem>
      <MenuItem disabled={controller.busy} onClick={() => { closeMenu(); void controller.create({ afterId: section.id }); }}>{t("sidebar.commodoreSection.createBelow")}</MenuItem>
      <div className="theater-menu-divider" role="separator" />
      <MenuItem danger onClick={() => { setMenu(null); setDeleting(true); }}>{t("sidebar.commodoreSection.deleteMenu")}</MenuItem>
    </SectionMenu> : null}
    {deleting && section ? <SectionDeleteDialog section={section} count={count} controller={controller} onClose={() => {
      setDeleting(false);
      requestAnimationFrame(() => {
        const target = header.current ?? document.querySelector<HTMLElement>(".objective-records-side-bar :is(.workspace-commodore-section-head, .side-bar-theater-activate)");
        target?.focus({ preventScroll: true });
      });
    }} /> : null}
  </li>;
}

function SectionNameInput({ name, onDone }: { readonly name: string; readonly onDone: (value: string | undefined, viaKey: boolean) => void }) {
  const t = useT();
  const [value, setValue] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const done = useRef(false);
  useLayoutEffect(() => { input.current?.focus({ preventScroll: true }); input.current?.select(); }, []);
  const finish = (save: boolean, viaKey: boolean) => { if (!done.current) { done.current = true; onDone(save ? value.trim().slice(0, MAX_SIDEBAR_SECTION_NAME) : undefined, viaKey); } };
  return <input ref={input} className="workspace-commodore-section-name" value={value} aria-label={t("sidebar.commodoreSection.rename")}
    onChange={(event) => setValue(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
    onContextMenu={(event) => event.stopPropagation()} onBlur={() => finish(true, false)}
    onKeyDown={(event) => {
      if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter" || event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(event.key === "Enter", true); }
    }} />;
}

function MenuItem({ children, onClick, disabled, danger }: { readonly children: ReactNode; readonly onClick: () => void; readonly disabled?: boolean; readonly danger?: boolean }) {
  return <button type="button" role="menuitem" className={`theater-menu-item${danger ? " theater-menu-forget" : ""}`} disabled={disabled} onClick={onClick}>{children}</button>;
}

function SectionMenu({ anchor, opener, label, children, onClose }: { readonly anchor: DOMRect; readonly opener: HTMLElement | null; readonly label: string; readonly children: ReactNode; readonly onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef(opener);
  const id = useId();
  const [position, setPosition] = useState({ left: anchor.left, top: anchor.bottom });
  useContextMenuKeyboard({ open: true, menuSelector: `[data-section-menu="${CSS.escape(id)}"]`, returnFocusRef, onEscape: onClose });
  useLayoutEffect(() => {
    const rect = menu.current!.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - rect.width - 8)), top: Math.max(8, Math.min(anchor.bottom, window.innerHeight - rect.height - 8)) });
  }, [anchor]);
  useEffect(() => {
    const element = anchorElementAt(anchor, menu.current?.parentElement);
    const scroll = (event: Event) => { if (scrollMovesAnchor(event, anchor, element)) onClose(); };
    window.addEventListener("resize", onClose); window.addEventListener("blur", onClose); window.addEventListener("scroll", scroll, true);
    return () => { window.removeEventListener("resize", onClose); window.removeEventListener("blur", onClose); window.removeEventListener("scroll", scroll, true); };
  }, [anchor, onClose]);
  return createPortal(<div className="group-context-menu-overlay workspace-commodore-section-menu-overlay" data-native-browser-transparent role="presentation" onPointerDown={onClose} onContextMenu={(event) => event.preventDefault()}>
    <div ref={menu} data-section-menu={id} role="menu" aria-label={label} className="theater-menu workspace-commodore-section-menu" style={{ position: "fixed", ...position }} onPointerDown={(event) => event.stopPropagation()}>{children}</div>
  </div>, document.body);
}

export function CommodoreSectionMoveMenu({ commodoreId, controller, onClose }: { readonly commodoreId: string; readonly controller: SidebarSectionsController; readonly onClose: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const id = useId();
  useContextMenuKeyboard({ open, menuSelector: `[data-section-submenu="${CSS.escape(id)}"]`, returnFocusRef: trigger, onEscape: () => { setOpen(false); trigger.current?.focus(); } });
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = trigger.current!.getBoundingClientRect(), rect = menu.current!.getBoundingClientRect();
    setPosition({ left: Math.max(8, anchor.right + rect.width + 8 > window.innerWidth ? anchor.left - rect.width : anchor.right), top: Math.max(8, Math.min(anchor.top, window.innerHeight - rect.height - 8)) });
  }, [open, controller.layout.sections.length]);
  const move = (sectionId: string | null) => { onClose(); void controller.run({ op: "move", commodoreId, sectionId }); };
  const current = controller.layout.membership[commodoreId] ?? null;
  return <div className="workspace-commodore-section-move" onPointerEnter={() => setOpen(true)} onPointerLeave={() => setOpen(false)}>
    <button ref={trigger} type="button" role="menuitem" className="theater-menu-item" aria-haspopup="menu" aria-expanded={open} disabled={controller.busy}
      onClick={() => setOpen(true)} onKeyDown={(event) => { if (event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); setOpen(true); } }}>
      <span className="theater-menu-label">{t("sidebar.commodoreSection.move")}</span><ChevronGlyph direction="right" />
    </button>
    {open ? <div ref={menu} data-section-submenu={id} className="theater-menu workspace-commodore-section-submenu" role="menu" aria-label={t("sidebar.commodoreSection.move")} style={{ position: "fixed", ...position }}
      onKeyDown={(event) => { if (event.key === "ArrowLeft") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); } }}>
      {[...controller.layout.sections, { id: null, name: t("sidebar.commodoreSection.none") }].map((section) => <button type="button" role="menuitemradio" aria-checked={current === section.id} key={section.id ?? "none"} className="theater-menu-item" onClick={() => move(section.id)}>
        <span className="theater-menu-check" aria-hidden="true">{current === section.id ? "✓" : ""}</span><span className="theater-menu-label">{section.name}</span>
      </button>)}
      <div className="theater-menu-divider" role="separator" />
      <MenuItem onClick={() => { onClose(); void controller.create({ commodoreId }); }}>{t("sidebar.commodoreSection.create")}</MenuItem>
    </div> : null}
  </div>;
}

function SectionDeleteDialog({ section, count, controller, onClose }: { readonly section: CommodoreSidebarSection; readonly count: number; readonly controller: SidebarSectionsController; readonly onClose: () => void }) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId(), bodyId = useId();
  useLayoutEffect(() => { dialog.current?.showModal(); cancel.current?.focus(); }, []);
  return createPortal(<dialog ref={dialog} className="workspace-commodore-section-dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId}
    onCancel={(event) => { event.preventDefault(); if (!controller.busy) onClose(); }}>
    <h2 id={titleId}>{t("sidebar.commodoreSection.deleteTitle", { name: section.name })}</h2>
    <p id={bodyId}>{t("sidebar.commodoreSection.deleteBody", { count })}</p>
    {controller.error ? <p role="alert">{t("sidebar.commodoreSection.error")}</p> : null}
    <footer><button ref={cancel} type="button" disabled={controller.busy} onClick={onClose}>{t("sidebar.commodore.cancel")}</button>
      <button type="button" className="workspace-commodore-section-delete" disabled={controller.busy} onClick={() => { void controller.run({ op: "delete", sectionId: section.id, confirm: true }).then((result) => { if (result) onClose(); }); }}>{t("sidebar.commodoreSection.delete")}</button></footer>
  </dialog>, document.body);
}
