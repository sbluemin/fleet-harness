import { useEffect, useRef, useState } from "react";

import type { RailPanelDescriptor } from "@fleet-console/sdk/rail";

import { useConsoleState } from "../hooks/use-store.js";
import {
  mountNavigatorInto,
  mountReaderInto,
  setNavigatorTheater,
  setOnRequestOpenReader,
  teardownCodex,
  teardownReaderNodes,
} from "../codex-host.js";
import { closeCodexReader, expandCodexReader, openCodexReader } from "../store.js";
import { loadInitialData } from "../codex/state.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface CodexWorkspaceState {
  readonly contextKey: string;
  readonly hasWiki: boolean;
  readonly id: string | null;
}

// ─── Rail panel descriptor ───────────────────────────────────────────────────

export const codexPanel: RailPanelDescriptor = {
  id: "codex",
  title: "Codex",
  icon: () => <CodexIcon />,
  pathAware: false,
  render: (ctx) => <CodexRailPanel theaterId={ctx.theaterId} />,
};

// ─── Components ───────────────────────────────────────────────────────────────

function CodexRailPanel({ theaterId }: { readonly theaterId: string | null }) {
  const state = useConsoleState();
  const navRef = useRef<HTMLDivElement>(null);
  const readRef = useRef<HTMLDivElement>(null);
  const tocRef = useRef<HTMLDivElement>(null);
  const latestContextKeyRef = useRef("");
  const [workspace, setWorkspace] = useState<CodexWorkspaceState | null>(null);

  const reader = state.codexReader;
  const hasReader = reader !== null;
  const expanded = state.codexReaderExpanded;
  const activeTheater = state.theaters.find((t) => t.id === state.activeTheaterId) ?? null;
  const hasTheaters = state.theaters.length > 0;
  const contextKey = theaterId ?? "";
  const workspaceId = workspace?.contextKey === contextKey && workspace.hasWiki ? workspace.id : null;
  const shouldMountCodex = workspaceId !== null;

  const readerKey = reader
    ? `${reader.kind}:${reader.kind === "entry" ? reader.entryId : reader.kind === "drydock" ? (reader.patchId ?? "") : reader.kind === "conflicts" ? (reader.id ?? "") : (reader.templateId ?? "")}`
    : null;

  // Theater 변경 시 이전 reader가 새 workspace에서 잠시 보이지 않도록 먼저 닫는다.
  useEffect(() => {
    latestContextKeyRef.current = contextKey;
    closeCodexReader();
    if (!theaterId) {
      setWorkspace({ contextKey, hasWiki: false, id: null });
      return;
    }
    void resolveCodexWorkspace(theaterId).then((result) => {
      if (latestContextKeyRef.current !== contextKey) return;
      setWorkspace({ contextKey, ...result });
    }).catch(() => {
      if (latestContextKeyRef.current !== contextKey) return;
      setWorkspace({ contextKey, hasWiki: false, id: null });
    });
  }, [contextKey, theaterId]);

  // 위키 없음이 확정된 경우에만 singleton을 정리한다. 다음 Theater를 해석하는 동안에는
  // destroy+remount하지 않고, 기존 host를 새 navigator 컨테이너로 relocate한다.
  useEffect(() => {
    if (workspace?.contextKey === contextKey && !workspace.hasWiki) teardownCodex();
  }, [contextKey, workspace]);

  useEffect(() => () => teardownCodex(), []);

  // navigator 마운트 + onRequest 등록 — hasReader 전환 시 navRef 컨테이너가 바뀌므로 재배치
  useEffect(() => {
    if (!shouldMountCodex || !workspaceId) return;
    const node = navRef.current;
    if (!node) return;
    mountNavigatorInto(node, workspaceId);
    setOnRequestOpenReader((r) => {
      if (r.kind === "entry") openCodexReader({ kind: "entry", entryId: r.id });
      else if (r.kind === "drydock") openCodexReader({ kind: "drydock", patchId: r.patchId });
      else if (r.kind === "conflicts") openCodexReader({ kind: "conflicts", id: r.id });
      else if (r.kind === "schema") openCodexReader({ kind: "schema", templateId: r.templateId });
    });
    return () => {
      setOnRequestOpenReader(null);
    };
  }, [shouldMountCodex, workspaceId, hasReader]);

  // Theater 해석으로 결정된 workspace 전환 시 navigator 데이터 소스를 바꾼다.
  useEffect(() => {
    if (shouldMountCodex && workspaceId) {
      setNavigatorTheater(workspaceId);
    }
  }, [shouldMountCodex, workspaceId]);

  // split reader mount — expanded=true면 오버레이가 처리 중이므로 건너뜀
  useEffect(() => {
    if (!shouldMountCodex || !workspaceId || !hasReader || expanded) return;
    if (!readRef.current || !tocRef.current || !reader) return;
    const kind = reader.kind;
    const subId = kind === "drydock" ? reader.patchId : kind === "conflicts" ? reader.id : kind === "schema" ? reader.templateId : undefined;
    mountReaderInto(readRef.current, tocRef.current, {
      initialEntryId: kind === "entry" ? reader.entryId : "",
      kind,
      subId,
      theaterId: workspaceId,
      onRelatedClick: (id) => openCodexReader({ kind: "entry", entryId: id }),
      onClose: () => closeCodexReader(),
      onPatchOpen: (pid) => openCodexReader({ kind: "drydock", patchId: pid }),
      onDecided: () => {
        void loadInitialData();
        openCodexReader({ kind: "drydock", patchId: undefined });
      },
    });
  }, [shouldMountCodex, workspaceId, hasReader, expanded, readerKey]);

  // hasReader=false 시 reader 호스트 노드 정리
  useEffect(() => {
    if (!hasReader) teardownReaderNodes();
  }, [hasReader]);

  if (!shouldMountCodex) {
    return <CodexEmpty activeTheater={activeTheater} hasTheaters={hasTheaters} />;
  }

  if (!hasReader) {
    return <div ref={navRef} className="codex-rail-host" />;
  }

  return (
    <div className="codex-rail-host is-split">
      <div className="codex-doc-pane">
        <div className="codex-doc-pane-head">
          <button
            className="codex-doc-expand"
            type="button"
            aria-label="Expand reading sheet"
            data-codex-expand="true"
            onClick={expandCodexReader}
          >
            ⤢ Expand
          </button>
          <button
            className="codex-reading-sheet-close"
            type="button"
            aria-label="Close document pane"
            onClick={closeCodexReader}
          >
            ✕
          </button>
        </div>
        <div ref={readRef} className="codex-doc-scroll" />
        <div ref={tocRef} className="codex-doc-toc-inline" />
      </div>
      <div ref={navRef} className="codex-nav-pane" />
    </div>
  );
}

function CodexEmpty({
  activeTheater,
  hasTheaters,
}: {
  readonly activeTheater: { readonly label: string } | null;
  readonly hasTheaters: boolean;
}) {
  if (!hasTheaters) {
    return (
      <section className="codex-empty-state">
        <p className="codex-empty-eyebrow">Codex</p>
        <h1>Add a Theater</h1>
        <p>Use the top bar Theater control to choose a project root before opening Codex.</p>
      </section>
    );
  }
  return (
    <section className="codex-empty-state">
      <p className="codex-empty-eyebrow">Codex unavailable</p>
      <h1>{activeTheater?.label || "This Theater"}</h1>
      <p>Fleet Wiki data could not be loaded for this Theater.</p>
    </section>
  );
}

async function resolveCodexWorkspace(theaterId: string): Promise<Omit<CodexWorkspaceState, "contextKey">> {
  const response = await fetch(`/api/v1/theaters/${encodeURIComponent(theaterId)}/codex-workspace`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!response.ok) throw new Error("codex_workspace_unavailable");
  return assertCodexWorkspace(await response.json());
}

function assertCodexWorkspace(value: unknown): Omit<CodexWorkspaceState, "contextKey"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_codex_workspace");
  const payload = value as Record<string, unknown>;
  if (Object.keys(payload).length !== 2 || typeof payload.hasWiki !== "boolean") throw new Error("invalid_codex_workspace");
  if (payload.hasWiki && typeof payload.id === "string" && /^[0-9a-f]{12}$/.test(payload.id)) {
    return { hasWiki: true, id: payload.id };
  }
  if (!payload.hasWiki && payload.id === null) return { hasWiki: false, id: null };
  throw new Error("invalid_codex_workspace");
}

function CodexIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" opacity="0.16" />
      <path d="M12 3v3.6M12 17.4V21M3 12h3.6M17.4 12H21" />
      <path d="M12 8.6 14.2 12 12 15.4 9.8 12Z" fill="currentColor" stroke="none" />
    </svg>
  );
}
