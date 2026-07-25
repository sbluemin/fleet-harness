import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import {
  applyWorkspacePreset,
  createWorkspacePreset,
  deleteWorkspacePreset,
  fetchOperations,
  fetchWorkspacePresets,
  renameWorkspacePreset,
} from "../api.js";
import { useCanvasState } from "../canvas/canvas-store.js";
import { useConsoleState } from "../hooks/use-store.js";
import { usePluginRegistry } from "../plugin-registry.js";
import { BUILT_IN_RAIL_PANELS } from "../rail/built-in-panels.js";
import { hydrateOperations } from "../store.js";
import type { DurableWorkspacePreset } from "../types.js";
import { applyWorkspacePresetClientLayout, captureWorkspacePresetLayout } from "../workspace-preset-layout.js";

const MAX_PRESET_NAME_LENGTH = 64;

interface WorkspacePresetsProps {
  readonly theaterId: string | null;
}

type EditorState =
  | { readonly kind: "create" }
  | { readonly kind: "rename"; readonly presetId: string }
  | null;

export function WorkspacePresets({ theaterId }: WorkspacePresetsProps) {
  const state = useConsoleState();
  const canvas = useCanvasState();
  const registry = usePluginRegistry();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<readonly DurableWorkspacePreset[]>([]);
  const [editor, setEditor] = useState<EditorState>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ readonly tone: "warning" | "error" | "success"; readonly text: string } | null>(null);
  const installedPanelIds = new Set([
    ...BUILT_IN_RAIL_PANELS.map((panel) => panel.id),
    ...registry.railPanels.filter((panel) => (panel.side ?? "right") === "right").map((panel) => panel.id),
  ]);

  useEffect(() => {
    setOpen(false);
    setPresets([]);
    setEditor(null);
    setMessage(null);
  }, [theaterId]);

  useEffect(() => {
    if (!open || !theaterId) return;
    const controller = new AbortController();
    setBusy(true);
    fetchWorkspacePresets(theaterId, controller.signal)
      .then(setPresets)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setMessage({ tone: "error", text: error instanceof Error ? error.message : "Unable to load presets." });
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [open, theaterId]);

  useEffect(() => {
    if (!open) return;
    const closeOnPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnPointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const beginCreate = () => {
    setEditor({ kind: "create" });
    setName("");
    setMessage(null);
  };

  const beginRename = (preset: DurableWorkspacePreset) => {
    setEditor({ kind: "rename", presetId: preset.id });
    setName(preset.name);
    setMessage(null);
  };

  const submitEditor = async (event: FormEvent) => {
    event.preventDefault();
    if (!theaterId || !editor || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      if (editor.kind === "create") {
        const preset = await createWorkspacePreset(theaterId, name, captureWorkspacePresetLayout(
          canvas,
          state.operations.filter((operation) => operation.theaterId === theaterId).map((operation) => operation.id),
        ));
        setPresets((current) => [...current, preset]);
        setMessage({ tone: "success", text: `Saved “${preset.name}”.` });
      } else {
        const preset = await renameWorkspacePreset(theaterId, editor.presetId, name);
        setPresets((current) => current.map((item) => item.id === preset.id ? preset : item));
        setMessage({ tone: "success", text: `Renamed to “${preset.name}”.` });
      }
      setEditor(null);
      setName("");
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Workspace Preset update failed." });
    } finally {
      setBusy(false);
    }
  };

  const applyPreset = async (presetId: string) => {
    if (!theaterId || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await applyWorkspacePreset(theaterId, presetId);
      const warning = applyWorkspacePresetClientLayout(
        result,
        state.operations.filter((operation) => operation.theaterId === theaterId).map((operation) => operation.id),
        installedPanelIds,
      );
      void fetchOperations(null).then(hydrateOperations).catch(() => {});
      setMessage(warning
        ? { tone: "warning", text: warning }
        : { tone: "success", text: `Applied “${result.preset.name}”.` });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Workspace Preset apply failed." });
    } finally {
      setBusy(false);
    }
  };

  const removePreset = async (preset: DurableWorkspacePreset) => {
    if (!theaterId || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await deleteWorkspacePreset(theaterId, preset.id);
      setPresets((current) => current.filter((item) => item.id !== preset.id));
      if (editor?.kind === "rename" && editor.presetId === preset.id) setEditor(null);
      setMessage({ tone: "success", text: `Deleted “${preset.name}”.` });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Workspace Preset delete failed." });
    } finally {
      setBusy(false);
    }
  };

  const moveListFocus = (event: KeyboardEvent, index: number) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const offset = event.key === "ArrowDown" ? 1 : -1;
    const next = (index + offset + presets.length) % presets.length;
    rowRefs.current[next]?.focus();
  };

  return (
    <span className="workspace-presets-control">
      <button
        ref={triggerRef}
        type="button"
        className="command-band-formation-toggle command-band-formation-seg workspace-presets-trigger"
        disabled={theaterId === null}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Workspace Presets"
        title="Workspace Presets"
        onClick={() => setOpen((current) => !current)}
      >
        <WorkspacePresetIcon />
      </button>
      {open ? (
        <div ref={popoverRef} className="workspace-presets-popover" role="dialog" aria-label="Workspace Presets">
          <div className="workspace-presets-head">
            <span className="workspace-presets-eyebrow">Workspace Presets</span>
            <button type="button" className="workspace-presets-save" onClick={beginCreate} disabled={busy}>Save current</button>
          </div>
          {editor ? (
            <form className="workspace-presets-editor" onSubmit={(event) => void submitEditor(event)}>
              <label htmlFor="workspace-preset-name">{editor.kind === "create" ? "Preset name" : "New name"}</label>
              <div className="workspace-presets-editor-row">
                <input
                  id="workspace-preset-name"
                  autoFocus
                  value={name}
                  maxLength={MAX_PRESET_NAME_LENGTH}
                  onChange={(event) => setName(event.target.value)}
                />
                <button type="submit" disabled={busy || name.trim().length === 0}>{editor.kind === "create" ? "Save" : "Rename"}</button>
                <button type="button" onClick={() => setEditor(null)}>Cancel</button>
              </div>
            </form>
          ) : null}
          <div className="workspace-presets-list" aria-label="Saved Workspace Presets">
            {presets.map((preset, index) => (
              <div className="workspace-presets-row" key={preset.id}>
                <button
                  ref={(node) => { rowRefs.current[index] = node; }}
                  type="button"
                  className="workspace-presets-apply"
                  disabled={busy}
                  onClick={() => void applyPreset(preset.id)}
                  onKeyDown={(event) => moveListFocus(event, index)}
                >
                  <span className="workspace-presets-name">{preset.name}</span>
                  <span className="workspace-presets-meta">{Object.keys(preset.layout.operationGeometries).length} operations</span>
                </button>
                <button type="button" className="workspace-presets-row-action" onClick={() => beginRename(preset)} disabled={busy} aria-label={`Rename ${preset.name}`}>Rename</button>
                <button type="button" className="workspace-presets-row-action is-delete" onClick={() => void removePreset(preset)} disabled={busy} aria-label={`Delete ${preset.name}`}>Delete</button>
              </div>
            ))}
            {!busy && presets.length === 0 ? <p className="workspace-presets-empty">No saved presets yet.</p> : null}
            {busy && presets.length === 0 ? <p className="workspace-presets-empty">Loading…</p> : null}
          </div>
          {message ? <p className={`workspace-presets-message is-${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>{message.text}</p> : null}
        </div>
      ) : null}
    </span>
  );
}

function WorkspacePresetIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 2.5h10v11l-5-3-5 3z" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
    </svg>
  );
}
