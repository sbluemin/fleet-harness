import { useEffect, useState } from "react";
import type { HostTransport } from "@fleet-console/sdk/host-context";
import { readHostJson } from "@fleet-console/sdk/host-context/browser";
import { objectiveTextFromPrompt, type QuickLaunchHostCreateResult, type QuickLaunchHostPort, type QuickLaunchHostSession, type QuickLaunchHostTheater } from "../../../../features/execution/client/quick-launch-host.js";
import { isShortcutRecording, matchesShortcutCommand } from "./shortcut-bindings.js";
import type { HostWorkspaceBinding } from "./use-host-workspace.js";

const CREATE_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 60_000;

export interface HostQuickLaunch extends QuickLaunchHostPort {
  /** 지금 선택된 원격 컴퓨터·세대에 회차를 연다. 쓰기 권한이 없거나 로컬이면 열지 않는다. */
  readonly open: () => boolean;
  readonly dispose: () => void;
}

interface OpenSession {
  view: QuickLaunchHostSession;
  readonly generation: number;
  readonly transport: HostTransport;
  readonly abort: AbortController;
  inFlight: boolean;
  /** 목표를 만든 Theater. 만든 뒤에는 다른 Theater로 바꿔 올리지 않는다. */
  theaterId: string | null;
}

/** 원격 Quick Launch 회차의 유일한 소유자다. host·수명·선택 세대가 바뀌면 회차와 진행 중 생성 요청을 함께 끝낸다. */
export function createHostQuickLaunch(binding: HostWorkspaceBinding): HostQuickLaunch {
  const listeners = new Set<() => void>();
  // 같은 컴퓨터에 대한 미발사 문면. 로컬 초안 슬롯과 다른 컴퓨터로 새지 않는다.
  const drafts = new Map<string, string>();
  let session: OpenSession | null = null;
  let nextId = 0;
  let disposed = false;

  const publish = () => { for (const listener of listeners) listener(); };

  function theatersOf(hostKey: string): readonly QuickLaunchHostTheater[] {
    const host = binding.workspace.getSnapshot().hosts.find((candidate) => candidate.hostKey === hostKey);
    return Object.freeze((host?.theaters ?? []).map((theater) => Object.freeze({ id: theater.id, label: theater.alias || theater.label })));
  }

  function current(open: OpenSession): boolean {
    const snapshot = binding.workspace.getSnapshot();
    return !disposed && session === open && !open.abort.signal.aborted && !open.transport.scope.signal.aborted
      && snapshot.selectionGeneration === open.generation && snapshot.selection.hostKey === open.view.hostKey
      && snapshot.foreground !== null && snapshot.canWrite && binding.getSelectedTransport() === open.transport;
  }

  function end(open: OpenSession): void {
    if (session !== open) return;
    session = null;
    open.abort.abort();
    publish();
  }

  // 선택은 workspace가 같은 고정 transport로 목표를 다시 확인한 뒤에만 바뀐다. 실행 중 Operation으로 꾸미지 않는다.
  // 확인 실패는 workspace가 오류 상태로 알리므로 여기서 다시 던지지 않는다.
  function select(open: OpenSession, objectiveId: string): Promise<void> {
    if (!open.theaterId) return Promise.resolve();
    return binding.workspace.activateObjective({ hostKey: open.view.hostKey, theaterId: open.theaterId, role: "commander", operationId: objectiveId }).catch(() => undefined);
  }

  const offWorkspace = binding.workspace.subscribe(() => {
    const open = session;
    if (!open) return;
    if (!current(open)) { end(open); return; }
    const theaters = theatersOf(open.view.hostKey);
    const same = theaters.length === open.view.theaters.length && theaters.every((theater, index) => theater.id === open.view.theaters[index]?.id && theater.label === open.view.theaters[index]?.label);
    if (same) return;
    open.view = Object.freeze({ ...open.view, theaters, theaterId: theaters.some((theater) => theater.id === open.view.theaterId) ? open.view.theaterId : null });
    publish();
  });

  return {
    getSnapshot: () => session?.view ?? null,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    open: () => {
      if (disposed) return false;
      const snapshot = binding.workspace.getSnapshot();
      const selection = snapshot.selection;
      const transport = binding.getSelectedTransport();
      const host = snapshot.hosts.find((candidate) => candidate.hostKey === selection.hostKey);
      if (selection.hostKey === "local" || snapshot.foreground === null || !snapshot.canWrite || !transport || !host
        || transport.scope.hostKey !== host.hostKey || transport.scope.epoch !== host.epoch || transport.scope.signal.aborted) return false;
      if (session && current(session)) return true;
      if (session) end(session);
      const theaters = theatersOf(host.hostKey);
      session = {
        view: Object.freeze({
          id: ++nextId, hostKey: host.hostKey, hostLabel: host.label, theaters,
          theaterId: theaters.some((theater) => theater.id === selection.theaterId) ? selection.theaterId : theaters[0]?.id ?? null,
          draft: drafts.get(host.hostKey) ?? "",
          created: null,
        }),
        generation: snapshot.selectionGeneration, transport, abort: new AbortController(), inFlight: false, theaterId: null,
      };
      publish();
      return true;
    },
    close: (draft) => {
      const open = session;
      if (!open) return;
      const created = open.view.created;
      if (created) {
        // 이미 만든 목표는 닫는다고 사라지지 않는다. 올리지 못한 이미지를 두고 그 목표로 넘어간다.
        const live = current(open);
        drafts.delete(open.view.hostKey);
        end(open);
        if (live) void select(open, created.id);
        return;
      }
      if (draft.trim().length > 0) drafts.set(open.view.hostKey, draft);
      else drafts.delete(open.view.hostKey);
      end(open);
    },
    create: async (view, input): Promise<QuickLaunchHostCreateResult> => {
      const open = session;
      if (!open || open.view.id !== view.id || !current(open)) return { kind: "stale" };
      if (open.inFlight) throw new Error("quick_launch_busy");
      const theaterId = open.view.created ? open.theaterId : input.theaterId;
      if (!theaterId || !open.view.theaters.some((theater) => theater.id === theaterId)) throw new Error("theater_missing");
      open.inFlight = true;
      try {
        const scope = open.transport.scope;
        let created = open.view.created;
        if (!created) {
          const { title, note } = objectiveTextFromPrompt(input.text);
          if (title.length === 0) throw new Error("title_required");
          const response = await open.transport.request("/plugins/objectives/objective/create", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ theaterId, title, ...(note !== null ? { note } : {}), language: input.language }),
            signal: AbortSignal.any([open.abort.signal, scope.signal, AbortSignal.timeout(CREATE_TIMEOUT_MS)]),
          });
          const body = await readHostJson<{ readonly objective?: unknown; readonly error?: unknown }>(scope, response);
          // 늦은 응답은 그사이 바뀐 선택을 되돌리지 않는다. 만든 목표는 그 컴퓨터의 목록에 남는다.
          if (!current(open)) return { kind: "stale" };
          if (!response.ok) throw new Error(typeof body.error === "string" && body.error.length > 0 ? body.error : "objective_create_failed");
          const made = readCreated(body.objective, theaterId);
          if (!made) throw new Error("invalid_objective_response");
          created = Object.freeze({ id: made.id, title: made.title || title });
          open.theaterId = theaterId;
          drafts.delete(open.view.hostKey);
          open.view = Object.freeze({ ...open.view, theaterId, draft: "", created });
          publish();
        }
        // 이미지는 방금 만든(또는 이 회차가 만든) 목표 하나에만 올린다. 같은 고정 transport·수명 밖으로 보내지 않는다.
        const failed: number[] = [];
        for (const [index, attachment] of input.attachments.entries()) {
          if (!current(open)) return { kind: "stale" };
          try {
            const response = await open.transport.request(`/plugins/objectives/attachment/add?objectiveId=${encodeURIComponent(created.id)}&name=${encodeURIComponent(attachment.name)}`, {
              method: "POST",
              headers: { "Content-Type": attachment.file.type || "application/octet-stream" },
              body: attachment.file,
              signal: AbortSignal.any([open.abort.signal, scope.signal, AbortSignal.timeout(UPLOAD_TIMEOUT_MS)]),
            });
            await readHostJson<unknown>(scope, response).catch(() => undefined);
            if (!response.ok) failed.push(index);
          } catch {
            if (!current(open)) return { kind: "stale" };
            failed.push(index);
          }
        }
        if (!current(open)) return { kind: "stale" };
        if (failed.length > 0) return { kind: "partial", failed };
        end(open);
        await select(open, created.id);
        return { kind: "created" };
      } catch (cause) {
        if (!current(open)) return { kind: "stale" };
        throw cause;
      } finally {
        open.inFlight = false;
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      offWorkspace();
      const open = session;
      session = null;
      open?.abort.abort();
      drafts.clear();
      publish();
      listeners.clear();
    },
  };
}

/** app 조립용. binding 수명과 같이 만들고 버린다. */
export function useHostQuickLaunch(binding: HostWorkspaceBinding | null): HostQuickLaunch | null {
  const [port, setPort] = useState<HostQuickLaunch | null>(null);
  useEffect(() => {
    if (!binding) { setPort(null); return; }
    const created = createHostQuickLaunch(binding);
    setPort(created);
    return () => created.dispose();
  }, [binding]);
  return port;
}

/**
 * 원격 선택 중에는 Console 전역 단축키가 서지 않는다. 같은 등록부 조합(Quick Launch)만 원격 회차 열기로 잇는다 —
 * 로컬 Quick Launch 토글로 물러나지 않으며, 다른 차단 다이얼로그가 떠 있거나 조합을 기록하는 중이면 키를 두고 간다.
 */
export function useHostQuickLaunchShortcut(port: HostQuickLaunch | null, enabled: boolean): void {
  useEffect(() => {
    if (!port || !enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isShortcutRecording(document) || !matchesShortcutCommand(event, "console.quick-launch")) return;
      const foreignModal = [...document.querySelectorAll('[aria-modal="true"]:not([hidden])')].some((element) => element.closest(".quick-launch-overlay") === null);
      if (foreignModal) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      // 이미 열린 회차는 그대로 둔다. 닫기는 컴포저의 Escape가 맡아 미발사 문면을 그 컴퓨터의 초안으로 넘긴다.
      if (port.getSnapshot() === null) port.open();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [port, enabled]);
}

function readCreated(value: unknown, theaterId: string): { readonly id: string; readonly title: string } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0 || record.theaterId !== theaterId) return null;
  return { id: record.id, title: typeof record.title === "string" ? record.title : "" };
}
